import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { hubClient as connectHub } from "../../protocol/client.ts";
import { parseRules } from "../../protocol/rules.ts";
import { typeMatches } from "../../kernel/rules.ts";
import { subjectFor } from "./controls.mjs";
import { failure, safeError } from "./catalog.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const regular = (file) =>
  typeof file === "string" && path.isAbsolute(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink();
const inside = (file, root) =>
  path.resolve(file) === path.resolve(root) || path.resolve(file).startsWith(path.resolve(root) + path.sep);

// Rules and event IDs belong to the existing hub. This class never runs a worker or schedules a timer job.
export class NativeLoopRuntime {
  constructor({
    nativeConfig,
    configFile,
    controls,
    hubClient,
    confirmAttempts = 40,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.config = nativeConfig;
    this.configFile = configFile;
    this.controls = controls;
    this.injectedHub = hubClient;
    this.confirmAttempts = Math.min(50, Math.max(1, confirmAttempts));
    this.wait = wait;
    this.projects = new Map();
  }
  layout() {
    const c = this.config,
      h = c?.loopHub;
    if (
      !h ||
      !regular(this.configFile) ||
      !regular(h.configFile) ||
      !regular(h.rulesFile) ||
      !/^[a-z][a-z0-9-]*$/.test(h.workerName ?? "") ||
      !path.isAbsolute(h.controlCwd ?? "") ||
      !lstatSync(h.controlCwd).isDirectory() ||
      lstatSync(h.controlCwd).isSymbolicLink()
    )
      throw failure("LOOP_HUB_CONFIG_INVALID");
    const privateHub = JSON.parse(readFileSync(h.configFile, "utf8")),
      url = new URL(privateHub.url);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !privateHub.owner ||
      !privateHub.source?.key ||
      !/^[a-z][a-z0-9-]*$/.test(privateHub.source.name ?? "")
    )
      throw failure("LOOP_HUB_CONFIG_INVALID");
    const owner = this.injectedHub ?? connectHub(privateHub.url, privateHub.owner);
    const source = this.injectedHub ?? connectHub(privateHub.url, privateHub.source.key);
    if (typeof owner.state !== "function" || typeof source.event !== "function")
      throw failure("LOOP_HUB_CONFIG_INVALID");
    return { ...h, owner, source, sourceName: privateHub.source.name, database: h.rulesFile + ".native-loop.db" };
  }
  validate(raw) {
    parseRules(JSON.stringify(raw), Date.now(), "Asia/Shanghai");
  }
  readRules(layout) {
    const text = readFileSync(layout.rulesFile, "utf8"),
      raw = JSON.parse(text);
    this.validate(raw);
    if (!raw.sources?.[layout.sourceName]) throw failure("LOOP_SOURCE_NOT_REGISTERED");
    return { text, raw };
  }
  async readiness(project) {
    try {
      const managed = this.config?.managedCodex,
        roots = Array.isArray(project?.roots) ? [...project.roots] : [],
        root = managed?.projectRoots?.[project?.key] ?? (roots.length === 1 ? roots[0] : null);
      if (
        project?.provider !== "codex" ||
        !project.key ||
        !project.nativeId ||
        managed?.enabled !== true ||
        typeof root !== "string" ||
        !path.isAbsolute(root) ||
        !roots.includes(root) ||
        !path.isAbsolute(managed.stateDir ?? "")
      )
        throw failure("LOOP_NATIVE_ROOT_UNCONFIRMED");
      const layout = this.layout();
      if (inside(layout.controlCwd, root) || inside(managed.stateDir, root))
        throw failure("LOOP_PRIVATE_SCOPE_INVALID");
      const { raw } = this.readRules(layout);
      this.candidate(
        raw,
        this.desired(project.key, { revision: this.controls.get(project.key).revision + 1 }, layout),
        project.key,
        true,
        layout,
      );
      const state = await layout.owner.state();
      if (
        !Array.isArray(state?.lines) ||
        !Array.isArray(state?.agents) ||
        !state.sources?.some((s) => s.id === layout.sourceName)
      )
        throw failure("LOOP_HUB_UNAVAILABLE");
      this.projects.set(project.key, { root, nativeId: project.nativeId, roots });
      return { ready: true, rulesReady: true };
    } catch (error) {
      this.projects.delete(project?.key);
      return { ready: false, rulesReady: false, code: safeError(error) };
    }
  }
  guard(projectKey, control) {
    const current = this.controls.get(projectKey);
    if (current.revision !== control.revision || current.mode !== control.mode || current.projectKey !== projectKey)
      throw failure("CONTROL_REVISION_CHANGED");
    if (current.mode === "active") this.controls.assertActive(projectKey, control.revision);
  }
  database(layout, fn) {
    if (existsSync(layout.database) && lstatSync(layout.database).isSymbolicLink())
      throw failure("LOOP_PRIVATE_SCOPE_INVALID");
    const db = new DatabaseSync(layout.database);
    chmodSync(layout.database, 0o600);
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL, state TEXT NOT NULL, ack TEXT); BEGIN IMMEDIATE;",
      );
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }
  desired(projectKey, control, layout) {
    const subject = subjectFor(projectKey),
      ruleName = `native-project:${subject}`,
      agentId = `native-managed-${subject}`;
    const eventType = `native.project.${subject.slice(0, 32)}.changed`;
    const agent = {
      name: `原生项目 ${subject.slice(0, 10)} · 控制 ${control.revision}`,
      worker: layout.workerName,
      use: "native-managed",
      access: "read",
      command: [this.configFile, projectKey],
    };
    const rule = {
      name: ruleName,
      when: { source: layout.sourceName, types: [eventType] },
      to: agentId,
      cwd: layout.controlCwd,
      group: ruleName,
      tell: "needed",
      prompt: `从可信原生配置读取目标、预算和最新控制状态。项目标识：${projectKey}；本次控制版本：${control.revision}。根据目标和当前证据，自主完成权限内可执行的下一步；等待执行结果可用 later 预约核实，重大决策用 ask 交本人决定。形成实质交付时最多发一条 notice 简报，无变化则安静结束。首版只读，不修改原项目；不能把一次核对当作所有目标已经完成，需明确交付、证据与剩余步骤。暂停后不再推进，按上游回执约定结束。`,
    };
    return { subject, ruleName, agentId, eventType, agent, rule };
  }
  candidate(raw, target, projectKey, active, layout) {
    const existingAgent = raw.agents[target.agentId];
    if (existingAgent && (existingAgent.use !== "native-managed" || existingAgent.command?.[1] !== projectKey))
      throw failure("LOOP_RULE_OWNERSHIP_CONFLICT");
    const priorRule = raw.rules.find((r) => r.name === target.ruleName);
    if (priorRule && priorRule.to !== target.agentId) throw failure("LOOP_RULE_OWNERSHIP_CONFLICT");
    raw.rules = raw.rules.filter((r) => r.name !== target.ruleName);
    if (active) {
      if (raw.rules.some((r) => r.when.source === layout.sourceName && typeMatches(r.when.types, target.eventType)))
        throw failure("LOOP_EVENT_SCOPE_CONFLICT");
      raw.agents[target.agentId] = target.agent;
      raw.rules.push(target.rule);
    } else if (!raw.rules.some((r) => r.to === target.agentId)) delete raw.agents[target.agentId];
    this.validate(raw);
  }
  async confirm(layout, target, control, projectKey) {
    for (let n = 0; n < this.confirmAttempts; n++) {
      this.guard(projectKey, control);
      const state = await layout.owner.state();
      this.guard(projectKey, control);
      const line = state?.lines?.find((l) => l.id === target.ruleName);
      const agent = state?.agents?.find((a) => a.id === target.agentId);
      const confirmed =
        control.mode !== "active"
          ? !line
          : line?.agent === target.agentId &&
            line.group === target.ruleName &&
            line.source === layout.sourceName &&
            JSON.stringify(line.types) === JSON.stringify([target.eventType]) &&
            agent?.name === target.agent.name &&
            agent.use === "native-managed" &&
            agent.worker === layout.workerName;
      if (confirmed && Array.isArray(state?.lines)) return;
      if (n + 1 < this.confirmAttempts) {
        this.guard(projectKey, control);
        await this.wait(100);
      }
    }
    throw failure("RULE_SYNC_UNCONFIRMED");
  }
  async answerCard({ cardId, choice, actor, requestId }) {
    if (
      !Number.isSafeInteger(cardId) ||
      cardId < 1 ||
      !Number.isSafeInteger(choice) ||
      choice < 1 ||
      typeof actor !== "string" ||
      !actor.trim() ||
      actor.length > 500 ||
      typeof requestId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,500}$/.test(requestId)
    )
      throw failure("LOOP_CARD_INPUT_INVALID");
    const { owner } = this.layout();
    if (typeof owner.answer !== "function") throw failure("LOOP_CARD_ANSWER_UNAVAILABLE");
    const read = async () => {
      const state = await owner.state();
      const matches = [...(state?.cards ?? []), ...(state?.recentCards ?? [])].filter((c) => c.id === cardId);
      if (matches.length !== 1) throw failure("LOOP_CARD_NOT_FOUND");
      const card = matches[0];
      if (
        card.kind !== "ask" ||
        !/^native-project:[a-f0-9]{64}$/.test(card.rule ?? "") ||
        !Array.isArray(card.options) ||
        choice > card.options.length ||
        !card.options.every((o) => typeof o === "string")
      )
        throw failure("LOOP_CARD_SCOPE_INVALID");
      const projects = this.controls.list().filter((c) => `native-project:${subjectFor(c.projectKey)}` === card.rule);
      if (projects.length !== 1) throw failure("LOOP_CARD_PROJECT_UNKNOWN");
      return { card, projectKey: projects[0].projectKey };
    };
    let { card, projectKey } = await read();
    const prior = () => ({
      ok: true,
      changed: false,
      cardId,
      projectKey,
      state: card.state,
      mode: this.controls.get(projectKey).mode,
      text: "这张决策卡已处理，没有重复提交，也不会重新启用项目。",
    });
    if (["decided", "closed", "done"].includes(card.state)) return prior();
    if (card.state !== "open") throw failure("LOOP_CARD_STATE_UNKNOWN");
    let control = this.controls.get(projectKey);
    const pause = ["已核实，保持暂停", "先暂停此目标"].includes(card.options[choice - 1]);
    if (pause)
      control = this.controls.set(projectKey, "paused", {
        actor: actor.trim(),
        expectedRevision: control.revision,
        requestId: requestId + ":pause",
      });
    if (control.mode !== "active") {
      try {
        this.guard(projectKey, control);
        await this.sync({ projectKey, control, action: control.mode === "paused" ? "pause" : "manual", requestId });
      } catch {
        return {
          ok: false,
          changed: false,
          cardId,
          projectKey,
          state: "unconfirmed",
          mode: this.controls.get(projectKey).mode,
          text: "项目当前状态已保留，但规则同步尚未核实，暂未提交回答。",
        };
      }
      const fresh = await read();
      if (
        fresh.projectKey !== projectKey ||
        fresh.card.rule !== card.rule ||
        JSON.stringify(fresh.card.options) !== JSON.stringify(card.options)
      )
        throw failure("LOOP_CARD_CHANGED");
      card = fresh.card;
      if (["decided", "closed", "done"].includes(card.state)) return prior();
      if (card.state !== "open") throw failure("LOOP_CARD_STATE_UNKNOWN");
    }
    this.guard(projectKey, control);
    try {
      const result = await owner.answer(cardId, { choice: choice - 1, by: actor.trim(), ref: requestId });
      if (typeof result?.changed !== "boolean" || !["decided", "closed", "done"].includes(result.state))
        throw failure("LOOP_CARD_ANSWER_UNCONFIRMED");
      const mode = this.controls.get(projectKey).mode;
      return {
        ok: true,
        changed: result.changed,
        cardId,
        projectKey,
        state: result.state,
        mode,
        text: result.changed
          ? `已记录第 ${choice} 个选择。${mode === "active" ? "后续按当前目标与预算推进。" : "项目保持暂停或仅查看，不会因此启用自动推进。"}`
          : "这张决策卡已经处理，没有重复提交。",
      };
    } catch {
      // The native card is the answer journal; an uncertain response never repeats the underlying business.
      return {
        ok: false,
        cardId,
        projectKey,
        state: "unconfirmed",
        mode: this.controls.get(projectKey).mode,
        text: "回答是否已保存尚未确认，请先核实原卡片状态，不要重做业务。",
      };
    }
  }
  async sync({ projectKey, control, action, requestId = control?.originRequestId }) {
    if (
      !control ||
      control.projectKey !== projectKey ||
      !Number.isSafeInteger(control.revision) ||
      control.revision < 1 ||
      !["active", "paused", "manual"].includes(control.mode) ||
      (control.mode === "active" ? !["enable", "resume"].includes(action) : !["pause", "manual"].includes(action))
    )
      throw failure("LOOP_SYNC_INPUT_INVALID");
    this.guard(projectKey, control);
    const active = control.mode === "active",
      layout = this.layout(),
      target = this.desired(projectKey, control, layout);
    const verified = this.projects.get(projectKey),
      selectedRoot =
        this.config.managedCodex?.projectRoots?.[projectKey] ??
        (verified?.roots.length === 1 ? verified.roots[0] : null);
    if (active && (!verified || this.config.managedCodex?.enabled !== true || selectedRoot !== verified.root))
      throw failure("LOOP_READINESS_REQUIRED");
    if (active && (typeof requestId !== "string" || !/^[A-Za-z0-9_.:-]{1,512}$/.test(requestId)))
      throw failure("CONTROL_REQUEST_ID_REQUIRED");
    const fingerprint = hash([projectKey, control.revision, action]);
    const payload = {
      id: "native-control-" + hash([projectKey, requestId]),
      type: target.eventType,
      subject: target.subject,
      summary: "本人已明确启用这个项目，请核对目标和当前状态后推进",
    };
    this.guard(projectKey, control);
    this.database(layout, (db) => {
      this.guard(projectKey, control);
      const old = active ? db.prepare("SELECT * FROM requests WHERE id=?").get(requestId) : null;
      if (old && (old.fingerprint !== fingerprint || old.payload !== JSON.stringify(payload)))
        throw failure("LOOP_REQUEST_REUSED");
      const { text, raw } = this.readRules(layout);
      this.candidate(raw, target, projectKey, active, layout);
      this.guard(projectKey, control);
      if (readFileSync(layout.rulesFile, "utf8") !== text) throw failure("LOOP_RULES_CHANGED");
      const replacement = JSON.stringify(raw, null, 2) + "\n",
        temporary = layout.rulesFile + "." + randomUUID() + ".tmp";
      if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(raw)) {
        try {
          writeFileSync(temporary, replacement, { flag: "wx", mode: 0o600 });
          this.guard(projectKey, control);
          renameSync(temporary, layout.rulesFile);
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary);
        }
      }
      if (active && !old)
        db.prepare("INSERT INTO requests VALUES(?,?,?,0,'pending',NULL)").run(
          requestId,
          fingerprint,
          JSON.stringify(payload),
        );
    });
    await this.confirm(layout, target, control, projectKey);
    if (!active) return { ok: true, emitted: false, mode: control.mode, revision: control.revision };
    while (true) {
      this.guard(projectKey, control);
      const pending = this.database(layout, (db) => {
        this.guard(projectKey, control);
        const row = db.prepare("SELECT * FROM requests WHERE id=?").get(requestId);
        if (row.state !== "acknowledged" && row.attempts < 3)
          db.prepare("UPDATE requests SET attempts=attempts+1,state='sending' WHERE id=?").run(requestId);
        return row;
      });
      if (pending.state === "acknowledged")
        return {
          ok: true,
          emitted: false,
          acknowledged: true,
          event: JSON.parse(pending.ack).event,
          revision: control.revision,
        };
      if (pending.attempts >= 3)
        return { ok: false, emitted: false, state: "unknown", code: "LOOP_EVENT_UNCONFIRMED", eventId: payload.id };
      let ack;
      try {
        this.guard(projectKey, control);
        ack = await layout.source.event(JSON.parse(pending.payload));
        if (!Number.isSafeInteger(ack?.event) || ack.event < 1 || !ack.routed?.includes(target.ruleName))
          throw failure("LOOP_EVENT_UNCONFIRMED");
      } catch (error) {
        this.database(layout, (db) =>
          db.prepare("UPDATE requests SET state='unknown' WHERE id=? AND state<>'acknowledged'").run(requestId),
        );
        this.guard(projectKey, control);
        await this.wait(100);
        continue;
      }
      this.database(layout, (db) =>
        db.prepare("UPDATE requests SET state='acknowledged',ack=? WHERE id=?").run(JSON.stringify(ack), requestId),
      );
      this.guard(projectKey, control);
      return {
        ok: true,
        emitted: ack.duplicate !== true,
        acknowledged: true,
        event: ack.event,
        revision: control.revision,
      };
    }
  }
}
