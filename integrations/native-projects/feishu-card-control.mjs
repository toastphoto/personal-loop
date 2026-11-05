import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, chmodSync, lstatSync, existsSync } from "node:fs";
import path from "node:path";
import { failure } from "./catalog.mjs";
import { projectAlias, projectDirectoryView, handleLoopCommand } from "./feishu-commands.mjs";
import { renderProjectCard } from "./feishu-project-card.mjs";
import { interpretProjectRequest } from "./feishu-intent.mjs";
const canonical = (v) =>
  v && typeof v === "object"
    ? Array.isArray(v)
      ? v.map(canonical)
      : Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
    : v;
const digest = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const nodes = (v) => (v && typeof v === "object" ? [v, ...Object.values(v).flatMap(nodes)] : []);
const parse = (value) => {
  try {
    const v = typeof value === "string" ? JSON.parse(value) : value;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw Error();
    return v;
  } catch {
    throw failure("CARD_ACTION_INVALID");
  }
};
const validGoal = (d) =>
  typeof d?.objective === "string" &&
  d.objective.trim() &&
  d.objective.length <= 1000 &&
  Number.isSafeInteger(d.maxSteps) &&
  d.maxSteps >= 1 &&
  d.maxSteps <= 100;

export class CardSessions {
  constructor(file, { now = Date.now } = {}) {
    this.now = now;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (lstatSync(path.dirname(file)).isSymbolicLink() || (existsSync(file) && lstatSync(file).isSymbolicLink()))
      throw failure("CARD_STORE_PATH_INVALID");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS card_sessions(id TEXT PRIMARY KEY,request_id TEXT UNIQUE,actor TEXT,chat TEXT,message_id TEXT UNIQUE,revision INTEGER,data_json TEXT,created_at INTEGER,expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS card_drafts(actor TEXT,chat TEXT,alias TEXT,revision INTEGER,data_json TEXT,PRIMARY KEY(actor,chat,alias));
      CREATE TABLE IF NOT EXISTS card_events(id TEXT PRIMARY KEY,hash TEXT,session_id TEXT,state TEXT,result_json TEXT);
      CREATE TABLE IF NOT EXISTS card_metadata(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS card_context(actor TEXT,chat TEXT,alias TEXT,updated_at INTEGER,PRIMARY KEY(actor,chat));`);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  decode(row) {
    return row
      ? {
          id: row.id,
          requestId: row.request_id,
          actor: row.actor,
          chat: row.chat,
          messageId: row.message_id,
          revision: row.revision,
          data: JSON.parse(row.data_json),
          expiresAt: row.expires_at,
        }
      : null;
  }
  get(id) {
    return this.decode(this.db.prepare("SELECT * FROM card_sessions WHERE id=?").get(id));
  }
  create(requestId, actor, chat, build) {
    return this.transaction(() => {
      const old = this.decode(this.db.prepare("SELECT * FROM card_sessions WHERE request_id=?").get(requestId));
      if (old) {
        if (old.actor !== actor || old.chat !== chat) throw failure("CARD_REQUEST_CONFLICT");
        return old;
      }
      const id = randomBytes(12).toString("hex"),
        data = build(id);
      this.db
        .prepare("INSERT INTO card_sessions VALUES(?,?,?,?,NULL,0,?,?,?)")
        .run(id, requestId, actor, chat, JSON.stringify(data), this.now(), this.now() + 13 * 86400000);
      return this.get(id);
    });
  }
  bind(id, messageId) {
    if (!/^om_[A-Za-z0-9_-]+$/.test(messageId)) throw failure("CARD_MESSAGE_INVALID");
    return this.transaction(() => {
      const s = this.get(id);
      if (!s || (s.messageId && s.messageId !== messageId)) throw failure("CARD_BINDING_CONFLICT");
      if (s.messageId) return false;
      this.db.prepare("UPDATE card_sessions SET message_id=? WHERE id=?").run(messageId, id);
      return true;
    });
  }
  advance(id, revision, data) {
    return this.transaction(() => {
      const s = this.get(id);
      if (!s || s.revision !== revision) throw failure("CARD_REVISION_CHANGED");
      this.db
        .prepare("UPDATE card_sessions SET revision=revision+1,data_json=? WHERE id=?")
        .run(JSON.stringify(data), id);
      return this.get(id);
    });
  }
  draft(actor, chat, alias) {
    const r = this.db.prepare("SELECT * FROM card_drafts WHERE actor=? AND chat=? AND alias=?").get(actor, chat, alias);
    return r ? { ...JSON.parse(r.data_json), revision: r.revision } : null;
  }
  saveDraft(actor, chat, alias, data, expectedRevision = 0) {
    if (!validGoal(data)) throw failure("CARD_GOAL_INVALID");
    return this.transaction(() => {
      const old = this.draft(actor, chat, alias);
      if ((old?.revision ?? 0) !== expectedRevision) throw failure("CARD_DRAFT_CHANGED");
      const revision = expectedRevision + 1;
      this.db
        .prepare(
          "INSERT INTO card_drafts VALUES(?,?,?,?,?) ON CONFLICT(actor,chat,alias) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json",
        )
        .run(
          actor,
          chat,
          alias,
          revision,
          JSON.stringify({ objective: data.objective.trim(), maxSteps: data.maxSteps }),
        );
      return this.draft(actor, chat, alias);
    });
  }
  verified(scope = "default") {
    return !!this.db.prepare("SELECT value FROM card_metadata WHERE key=?").get("callback_verified:" + scope);
  }
  verifyCallback(scope = "default") {
    this.db
      .prepare("INSERT OR IGNORE INTO card_metadata VALUES(?,?)")
      .run("callback_verified:" + scope, String(this.now()));
  }
  context(actor, chat) {
    const r = this.db.prepare("SELECT * FROM card_context WHERE actor=? AND chat=?").get(actor, chat);
    return r && this.now() - r.updated_at <= 15 * 60000 ? r.alias : null;
  }
  remember(actor, chat, alias) {
    this.db
      .prepare(
        "INSERT INTO card_context VALUES(?,?,?,?) ON CONFLICT(actor,chat) DO UPDATE SET alias=excluded.alias,updated_at=excluded.updated_at",
      )
      .run(actor, chat, alias, this.now());
  }
  beginEvent(id, hash, sessionId) {
    return this.transaction(() => {
      const r = this.db.prepare("SELECT * FROM card_events WHERE id=?").get(id);
      if (r) {
        if (r.hash !== hash || r.session_id !== sessionId) throw failure("CARD_EVENT_CONFLICT");
        return { state: r.state, result: r.result_json ? JSON.parse(r.result_json) : null };
      }
      this.db.prepare("INSERT INTO card_events VALUES(?,?,?,'pending',NULL)").run(id, hash, sessionId);
      return null;
    });
  }
  finishEvent(id, result) {
    this.db.prepare("UPDATE card_events SET state='done',result_json=? WHERE id=?").run(JSON.stringify(result), id);
    return result;
  }
  close() {
    this.db.close();
  }
}

export class ProjectCardController {
  constructor(config, { store, catalog, controls, runtime, activity, transportReady = () => true } = {}) {
    Object.assign(this, { config, store, catalog, controls, runtime, activity, transportReady });
    this.scope = digest([config.profile ?? "", config.chatId, [...config.allowedSenderIds].sort()]);
  }
  enabled() {
    return this.store.verified(this.scope) && this.transportReady();
  }
  bind(id, messageId) {
    const firstBinding = this.store.bind(id, messageId);
    if (!firstBinding) return;
    const session = this.store.get(id);
    if (session.data.navigation.alias) this.store.remember(session.actor, session.chat, session.data.navigation.alias);
  }
  response(session) {
    return {
      type: "interactive",
      sessionId: session.id,
      revision: session.revision,
      messageId: session.messageId,
      card: session.data.card,
    };
  }
  async overview(snapshot) {
    const overview = snapshot ?? (await this.catalog.refresh());
    return { overview, view: { ...projectDirectoryView(overview, this.controls), observedAt: overview.observedAt } };
  }
  targets(overview) {
    return Object.fromEntries(overview.projects.map((p) => [projectAlias(p), p.key]));
  }
  decorateLocal(view, targets, alias, actor, chat) {
    const p = view.projects.find((p) => p.alias === alias);
    if (!p) return;
    const key = targets[alias];
    if (key) {
      const parts = key.split(":").map(decodeURIComponent);
      if (parts.length !== 3 || projectAlias({ provider: parts[0], host: parts[1], nativeId: parts[2] }) !== alias)
        throw failure("CARD_TARGET_MISMATCH");
    }
    const control = key
      ? this.controls.get(key)
      : this.controls.list().find((c) => {
          try {
            const [provider, host, nativeId] = c.projectKey.split(":").map(decodeURIComponent);
            return projectAlias({ provider, host, nativeId }) === alias;
          } catch {
            return false;
          }
        });
    const current = control ?? { mode: "manual", revision: 0 };
    p.mode = current.mode;
    p.revision = current.revision;
    p.controlRevision = current.revision;
    p.objective = current.objective ?? "";
    p.maxSteps = current.maxSteps;
    p.draft = this.store.draft(actor, chat, alias);
    const supported = !!key && ["managed-read-only", "native"].includes(p.execution);
    p.canSetGoal = !!key;
    p.canPause = current.mode === "active";
    p.canStart = supported && current.mode !== "active" && validGoal(p.draft);
    p.canResume = supported && current.mode === "paused" && validGoal(current);
    p.controlReason = "目录使用上次读取结果 执行前会实时核对";
  }
  async enrich(view, overview, alias, actor, chat, previewDraft) {
    const p = view.projects.find((p) => p.alias === alias);
    if (!p) return;
    const native = overview.projects.find((n) => projectAlias(n) === alias);
    const control = native
      ? this.controls.get(native.key)
      : this.controls.list().find((c) => {
          try {
            const [provider, host, nativeId] = c.projectKey.split(":").map(decodeURIComponent);
            return projectAlias({ provider, host, nativeId }) === alias;
          } catch {
            return false;
          }
        });
    const current = control ?? { mode: "manual", revision: 0 };
    p.controlRevision = current.revision;
    p.revision = current.revision;
    p.mode = current.mode;
    p.objective = current.objective ?? "";
    p.maxSteps = current.maxSteps;
    const savedDraft = this.store.draft(actor, chat, alias);
    p.draft = previewDraft ? { ...previewDraft, revision: savedDraft?.revision ?? 0 } : savedDraft;
    p.canSetGoal = !!native;
    p.canPause = current.mode === "active";
    let ready = false;
    if (native && (native.capabilities?.startOwned || native.capabilities?.continue)) {
      try {
        const check = await this.runtime?.readiness(native);
        ready = check?.ready === true && check.rulesReady === true;
      } catch {}
    }
    p.canStart = ready && current.mode !== "active" && validGoal(p.draft);
    p.canResume = ready && current.mode === "paused" && validGoal(current);
    if (!ready) p.controlReason = "目前可查看和保存目标 自动执行尚未就绪";
    if (current.mode === "active") p.controlReason = "保存新草稿不会覆盖正在推进的目标";
  }
  async readActivity(view, targets, alias, { workId, force = false } = {}) {
    if (!this.activity || !alias) return;
    const project = view.projects.find((p) => p.alias === alias);
    if (!project) return;
    const key = targets[alias];
    if (!key) {
      project.activity = {
        status: "unavailable",
        complete: false,
        works: [],
        selected: null,
        note: "当前项目归属尚未核对 没有读取会话正文",
      };
      return;
    }
    try {
      project.activity = await this.activity.read(key, { workId, force });
    } catch {
      project.activity = {
        status: "unavailable",
        complete: false,
        works: [],
        selected: null,
        note: "会话归属或读取结果未能确认 没有显示回复 请刷新目录后再试",
      };
    }
  }
  render(sessionId, revision, view, navigation, notice) {
    return renderProjectCard(view, navigation, {
      sessionId,
      revision,
      interactive: true,
      mutationEnabled: this.enabled(),
      notice,
    });
  }
  async create(item, navigation = { screen: "home" }, notice, previewDraft, snapshot) {
    const actor = item.event.sender_id,
      chat = item.event.chat_id;
    if (chat !== this.config.chatId || !this.config.allowedSenderIds.includes(actor))
      throw failure("CARD_SCOPE_MISMATCH");
    const { view, overview } = await this.overview(snapshot);
    if (navigation.alias) await this.enrich(view, overview, navigation.alias, actor, chat, previewDraft);
    if (!this.enabled()) navigation = { screen: "probe" };
    if (navigation.screen === "detail") await this.readActivity(view, this.targets(overview), navigation.alias);
    const s = this.store.create(item.requestId, actor, chat, (id) => ({
      view,
      targets: this.targets(overview),
      navigation,
      notice,
      card: this.render(id, 0, view, navigation, notice),
    }));
    return this.response(s);
  }
  async prepare(item, result, snapshot) {
    if (!result?.ok || !["project-directory", "project-status"].includes(result.view?.kind)) return null;
    return this.create(
      item,
      result.view.kind === "project-status"
        ? { screen: "detail", alias: result.view.project.alias }
        : { screen: "home" },
      undefined,
      undefined,
      snapshot,
    );
  }
  async natural(item, text) {
    const { view, overview } = await this.overview();
    const actor = item.event.sender_id,
      chat = item.event.chat_id;
    const intent = interpretProjectRequest(text, { view, contextAlias: this.store.context(actor, chat) });
    if (intent.kind === "help")
      return {
        ok: true,
        action: "natural",
        text:
          intent.text || "我可以查看项目、显示状态、设置目标、暂停或恢复。请说出项目名称；修改运行状态会先显示确认卡。",
      };
    let navigation = { screen: "home" },
      notice = intent.text;
    if (intent.alias) {
      navigation = { screen: "detail", alias: intent.alias };
      if (intent.kind === "proposal") {
        if (["goal", "enable"].includes(intent.action)) navigation.screen = "goal";
        else if (intent.action === "resume") navigation.screen = "confirm-resume";
        notice =
          intent.action === "pause"
            ? "请核对项目后点击“暂停后续推进”"
            : intent.action === "resume"
              ? "请核对原目标后确认恢复"
              : "请先保存目标草稿 再明确启动";
      }
    } else if (intent.kind === "clarify") notice = "没有确定唯一项目 请从目录选择具体项目后再操作";
    const response = await this.create(
      item,
      navigation,
      notice,
      intent.objective ? { objective: intent.objective, maxSteps: 3, revision: 0 } : undefined,
      overview,
    );
    return { ok: true, action: "natural", text: "请在项目卡片中查看或确认", response };
  }
  decodeEvent(e) {
    if (
      !e ||
      e.actor === undefined ||
      e.chat !== this.config.chatId ||
      !this.config.allowedSenderIds.includes(e.actor) ||
      e.host !== "im_message" ||
      !/^om_[A-Za-z0-9_-]+$/.test(e.cardMessageId ?? "") ||
      typeof e.eventId !== "string" ||
      !e.eventId ||
      e.eventId.length > 256
    )
      throw failure("CARD_SCOPE_MISMATCH");
    let value, form;
    if (e.formValue) {
      form = parse(e.formValue);
      const match = /^plgoal_([a-f0-9]{24})_(\d+)$/.exec(e.actionName ?? "");
      if (!match) throw failure("CARD_ACTION_INVALID");
      value = { session: match[1], revision: Number(match[2]), action: "save-goal" };
    } else {
      value = parse(e.actionValue);
      if (value.personal_loop !== "projects-v1") throw failure("CARD_ACTION_INVALID");
    }
    if (!/^[a-f0-9]{24}$/.test(value.session ?? "") || !Number.isSafeInteger(value.revision) || value.revision < 0)
      throw failure("CARD_ACTION_INVALID");
    const session = this.store.get(value.session);
    if (
      !session ||
      session.actor !== e.actor ||
      session.chat !== e.chat ||
      session.messageId !== e.cardMessageId ||
      session.expiresAt < this.store.now()
    )
      throw failure("CARD_SCOPE_MISMATCH");
    return { session, value, form };
  }
  issued(session, value, e, form) {
    if (form) {
      if (
        e.actionTag !== "button" ||
        !nodes(session.data.card).some((o) => o.form_action_type === "submit" && o.name === e.actionName) ||
        Object.keys(form).sort().join(",") !== "max_steps,objective"
      )
        throw failure("CARD_ACTION_NOT_ISSUED");
      const options =
        nodes(session.data.card).find((o) => o.tag === "select_static" && o.name === "max_steps")?.options ?? [];
      const data = { objective: form.objective, maxSteps: Number(form.max_steps) };
      if (!options.some((o) => o.value === form.max_steps) || !validGoal(data)) throw failure("CARD_GOAL_INVALID");
      return data;
    }
    const issued = nodes(session.data.card).find((o) =>
      (o.behaviors ?? []).some((b) => b.type === "callback" && digest(b.value) === digest(value)),
    );
    if (!issued || issued.tag !== e.actionTag) throw failure("CARD_ACTION_NOT_ISSUED");
    if (value.action === "select" && !issued.options?.some((o) => o.value === e.option))
      throw failure("CARD_ACTION_NOT_ISSUED");
    return null;
  }
  async refreshSession(
    session,
    navigation,
    notice,
    { fresh = false, activity = false, workId, forceActivity = false } = {},
  ) {
    let view, targets;
    if (fresh || !session.data.targets) {
      const result = await this.overview();
      view = result.view;
      targets = this.targets(result.overview);
      if (navigation.alias) await this.enrich(view, result.overview, navigation.alias, session.actor, session.chat);
    } else {
      view = structuredClone(session.data.view);
      targets = session.data.targets;
      for (const p of view.projects) this.decorateLocal(view, targets, p.alias, session.actor, session.chat);
    }
    if (activity && navigation.screen === "detail") {
      await this.readActivity(view, targets, navigation.alias, { workId, force: forceActivity });
      this.decorateLocal(view, targets, navigation.alias, session.actor, session.chat);
    }
    const next = {
      view,
      targets,
      navigation,
      notice,
      card: this.render(session.id, session.revision + 1, view, navigation, notice),
    };
    return this.response(this.store.advance(session.id, session.revision, next));
  }
  async recoverPending(session, e) {
    const requestId = "card:" + digest(e.eventId);
    const receipt = this.controls.read().requests?.[requestId]?.result;
    let notice = "上次点击处理中断 已显示当前状态 请核对后重新操作";
    if (receipt?.projectKey) {
      const current = this.controls.get(receipt.projectKey);
      if (current.revision === receipt.revision) {
        let paused = current;
        if (current.mode === "active") {
          paused = this.controls.set(current.projectKey, "paused", {
            actor: e.actor,
            expectedRevision: current.revision,
            requestId: requestId + ":recover-pause",
          });
          notice = "上次启动确认处理中断 已暂停后续推进 请核对后明确恢复";
        }
        if (paused.mode === "paused") {
          try {
            const sync = await this.runtime.sync({
              projectKey: paused.projectKey,
              control: paused,
              action: "pause",
              requestId: requestId + ":recover-pause",
            });
            if (sync?.ok !== true) notice += " 规则同步仍待核对";
          } catch {
            notice += " 规则同步仍待核对";
          }
        }
      }
    }
    return this.store.finishEvent(
      e.eventId,
      await this.refreshSession(session, { screen: "detail", alias: session.data.navigation.alias }, notice),
    );
  }
  async handle(e) {
    const { session, value, form } = this.decodeEvent(e);
    const prior = this.store.db.prepare("SELECT * FROM card_events WHERE id=?").get(e.eventId);
    const fingerprint = digest(e);
    if (prior) {
      if (prior.hash !== fingerprint || prior.session_id !== session.id) throw failure("CARD_EVENT_CONFLICT");
      if (prior.state === "done") return JSON.parse(prior.result_json);
      return this.recoverPending(session, e);
    }
    if (value.revision !== session.revision) {
      this.store.beginEvent(e.eventId, fingerprint, session.id);
      return this.store.finishEvent(e.eventId, this.response(session));
    }
    const goal = this.issued(session, value, e, form);
    this.store.beginEvent(e.eventId, fingerprint, session.id);
    let navigation = { ...session.data.navigation },
      notice;
    const alias = value.alias ?? (value.action === "select" ? e.option : navigation.alias);
    const shown = session.data.view.projects.find((p) => p.alias === alias);
    try {
      if (value.action === "probe") {
        this.store.verifyCallback(this.scope);
        navigation = { screen: "home" };
        notice = "按钮连接已验证 现在可以选择项目";
      } else if (!this.enabled()) throw failure("CARD_CALLBACK_UNAVAILABLE");
      else if (value.action === "home")
        navigation = { screen: "home", ...(value.provider ? { provider: value.provider } : {}) };
      else if (["list", "page"].includes(value.action))
        navigation = { screen: "list", provider: value.provider, page: value.page ?? 0 };
      else if (["detail", "select"].includes(value.action)) {
        navigation = { screen: "detail", alias };
        this.store.remember(e.actor, e.chat, alias);
      } else if (value.action === "refresh") navigation = { ...navigation };
      else if (["activity-work", "activity-refresh"].includes(value.action)) navigation = { screen: "detail", alias };
      else if (value.action === "edit-goal") navigation = { screen: "goal", alias };
      else if (value.action === "save-goal") {
        if (!shown?.canSetGoal || navigation.screen !== "goal") throw failure("CARD_ACTION_NOT_ISSUED");
        this.store.saveDraft(e.actor, e.chat, alias, goal, shown.draft?.revision ?? 0);
        navigation = { screen: "detail", alias };
        notice = "目标草稿已保存 尚未启动";
      } else if (value.action === "start") navigation = { screen: "confirm-start", alias };
      else if (value.action === "resume") navigation = { screen: "confirm-resume", alias };
      else if (["confirm-start", "confirm-resume", "pause"].includes(value.action)) {
        if (!shown) throw failure("CARD_ACTION_NOT_ISSUED");
        let command;
        if (value.action === "confirm-start") {
          const draft = this.store.draft(e.actor, e.chat, alias);
          if (!validGoal(draft) || digest(draft) !== digest(shown.draft)) throw failure("CARD_DRAFT_CHANGED");
          command = { action: "enable", target: alias, objective: draft.objective, maxSteps: draft.maxSteps };
        } else command = { action: value.action === "pause" ? "pause" : "resume", target: alias };
        command.expectedRevision = shown.controlRevision ?? shown.revision;
        const result = await handleLoopCommand(command, {
          catalog: this.catalog,
          controls: this.controls,
          actor: e.actor,
          requestId: "card:" + digest(e.eventId),
          readiness: (p) => this.runtime.readiness(p),
          syncRules: (a) => this.runtime.sync(a),
        });
        notice = result.text;
        navigation = { screen: "detail", alias };
      } else throw failure("CARD_ACTION_NOT_ISSUED");
      return this.store.finishEvent(
        e.eventId,
        await this.refreshSession(session, navigation, notice, {
          fresh: ["start", "resume", "refresh"].includes(value.action),
          activity: ["detail", "select", "activity-work", "activity-refresh", "refresh"].includes(value.action),
          workId: value.action === "activity-work" ? value.workId : undefined,
          forceActivity: ["activity-refresh", "refresh"].includes(value.action),
        }),
      );
    } catch (error) {
      const notice =
        error.code === "CARD_DRAFT_CHANGED"
          ? "目标草稿已在别处更新 请核对后重新确认"
          : "本次操作没有确认成功 已显示当前状态 请核对后重试";
      return this.store.finishEvent(
        e.eventId,
        await this.refreshSession(this.store.get(session.id), { screen: "detail", alias }, notice),
      );
    }
  }
  current(response) {
    const s = this.store.get(response.sessionId);
    return !!s && s.messageId === response.messageId && s.revision === response.revision;
  }
}
