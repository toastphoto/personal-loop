// A checkpoint is an owner-visible question about one exact source item. It never creates or resumes a native chat.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readConfig } from "./factory.mjs";
import { queueBoundChat, inspectBoundChat } from "./bound-chat.mjs";
import { wakeQueuedBoundChat } from "./bound-wake.mjs";
import { readCheckpointItems, checkpointItemFingerprint } from "./checkpoint-source.mjs";
import { renderDecisionCard, renderResultCard } from "../../plugins/feishu-group-text/channel.ts";
import { validReply, requiresReply } from "../../plugins/feishu-group-text/decision-response.ts";
import { redact } from "./project-activity.mjs";

const fail = (code) => Object.assign(new Error(code), { code });
const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const load = (f) => JSON.parse(readFileSync(f, "utf8"));
const idOK = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const refOK = (v) => typeof v === "string" && /^om_[A-Za-z0-9_-]{1,160}$/.test(v);
const nativeId = (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(v);
const plain = (v, n) =>
  typeof v === "string" &&
  !!v.trim() &&
  v.length <= n &&
  redact(v) === v &&
  !/[\p{Cc}\p{Cf}<>`@]|https?:\/\/|(?:~\/|\/(?:Users|Volumes|private|tmp|home)\/)|\b(?:ou|oc|om|omt)_[A-Za-z0-9_-]+/iu.test(
    v,
  );
function execute(program, args, { input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = execFile(
      program,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 1048576,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      },
      (error, stdout) => resolve({ exitCode: error ? 1 : 0, stdout }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
function stillPending(item, event) {
  if (
    typeof item.text !== "string" ||
    /(?:已(?:经)?(?:解决|决定|选定|选择)|已经确认|不再(?:需要|等待)|无需(?:确认|选择|决定)|改(?:成|为)|取消(?:这个|该)?(?:问题|选择|方案))/u.test(
      item.text,
    )
  )
    return false;
  const norm = (value) => (typeof value === "string" ? value.normalize("NFKC").replace(/[\s\p{P}]/gu, "") : "");
  const sameQuestion = (q) =>
    norm(q.title) === norm(event.question) &&
    Array.isArray(q.options) &&
    q.options.length === event.options?.length &&
    q.options.every((v, i) => norm(v) === norm(event.options[i]));
  if (Array.isArray(item.questions) && item.questions.some(sameQuestion)) return true;
  const asking =
    /(?:需要你(?:拍板|决定|确认)|请(?:你|您)?(?:选|决定|确认)|待(?:你|您)(?:选|决定|确认)|等待(?:你|您)(?:选|决定|确认))/u.test(
      item.text,
    );
  return (
    asking &&
    norm(item.text).includes(norm(event.question)) &&
    event.options?.every((o) => norm(item.text).includes(norm(o)))
  );
}
function saved(row) {
  return row && { ...row, event: JSON.parse(row.event_json) };
}
function privateDatabase(file, readonly = false) {
  const parent = path.dirname(file);
  if (!readonly) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const d = lstatSync(parent);
  if (!d.isDirectory() || d.uid !== process.getuid() || (d.mode & 0o077) !== 0 || realpathSync(parent) !== parent)
    throw fail("CHECKPOINT_PRIVATE_STATE_REQUIRED");
  if (existsSync(file)) {
    const s = lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077) !== 0)
      throw fail("CHECKPOINT_PRIVATE_STATE_REQUIRED");
  } else if (readonly) return null;
  const db = new DatabaseSync(file, { readOnly: readonly });
  try {
    if (readonly) db.exec("PRAGMA query_only=ON");
    else {
      chmodSync(file, 0o600);
      db.exec(
        "PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS checkpoint_cards(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,event_json TEXT NOT NULL,created_at INTEGER NOT NULL,ref TEXT,send_attempts INTEGER NOT NULL DEFAULT 0,send_first_at INTEGER,send_lease INTEGER NOT NULL DEFAULT 0,choice INTEGER,native_status TEXT,answer_lease INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'open',display_version INTEGER NOT NULL DEFAULT 1)",
      );
      if (
        !db
          .prepare("PRAGMA table_info(checkpoint_cards)")
          .all()
          .some((c) => c.name === "answer_text")
      )
        db.exec("ALTER TABLE checkpoint_cards ADD COLUMN answer_text TEXT");
      if (
        !db
          .prepare("PRAGMA table_info(checkpoint_cards)")
          .all()
          .some((column) => column.name === "answer_lease")
      )
        db.exec("ALTER TABLE checkpoint_cards ADD COLUMN answer_lease INTEGER NOT NULL DEFAULT 0");
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
function validateEvent(e) {
  if (
    !e ||
    !["decision", "blocker"].includes(e.kind) ||
    !nativeId(e.projectKey) ||
    !nativeId(e.threadId) ||
    !nativeId(e.turnId) ||
    !nativeId(e.itemId) ||
    !Number.isFinite(e.at) ||
    !plain(e.summary, 300) ||
    !plain(e.question, 160) ||
    typeof e.evidence !== "string" ||
    !e.evidence.trim() ||
    e.evidence.length > 180 ||
    !/^[a-f0-9]{64}$/.test(e.sourceHash ?? "") ||
    !/^checkpoint-[a-f0-9]{48}$/.test(e.eventKey ?? "") ||
    !/^([a-f0-9]{64})$/.test(e.scope ?? "")
  )
    throw fail("CHECKPOINT_EVENT_INVALID");
  if (
    e.options !== undefined &&
    (!Array.isArray(e.options) ||
      e.options.length < 2 ||
      e.options.length > 5 ||
      e.options.some((x) => !plain(x, 100)) ||
      new Set(e.options).size !== e.options.length)
  )
    throw fail("CHECKPOINT_EVENT_INVALID");
  if (
    e.recommend !== undefined &&
    (!Number.isSafeInteger(e.recommend) ||
      !e.options ||
      e.recommend < 0 ||
      e.recommend >= e.options.length ||
      !plain(e.reason, 200))
  )
    throw fail("CHECKPOINT_EVENT_INVALID");
}
function sourceScope(c, n, e) {
  const o = c.proactiveNotices,
    b = n.managedCodex?.boundChats?.[e.projectKey];
  const targets = o.targets.filter((t) => t?.projectKey === e.projectKey && t.threadId === e.threadId);
  if (
    targets.length !== 1 ||
    !b ||
    b.threadId !== e.threadId ||
    b.root !== n.managedCodex.projectRoots?.[e.projectKey] ||
    e.projectKey !== "codex:local:" + encodeURIComponent(b.projectId) ||
    !n.managedCodex.coordinatorProjectKeys?.includes(e.projectKey) ||
    digest([c.profile, c.chatId, o.enabledAt, e.projectKey, b]) !== e.scope ||
    (e.itemScope !== undefined && e.itemScope !== digest([e.scope, o.checkpointEnabledAt]))
  )
    throw fail("CHECKPOINT_SCOPE_REVOKED");
  return targets[0];
}
export class CheckpointDecisionCards {
  constructor({
    configFile,
    config,
    nativeConfig,
    execute: run = execute,
    validateSource,
    readItems = readCheckpointItems,
    queueBound = queueBoundChat,
    inspectBound = inspectBoundChat,
    now = Date.now,
  }) {
    Object.assign(this, { configFile, nativeConfig, run, validateSource, readItems, queueBound, inspectBound, now });
    this.destination = {
      profile: config.profile,
      chatId: config.chatId,
      allowedSenderIds: [...config.allowedSenderIds],
      nativeConfigFile: config.nativeConfigFile,
    };
    const current = this.settings();
    privateDatabase(current.o.checkpointStateFile).close();
  }
  settings(event) {
    const c = load(this.configFile),
      o = c.proactiveNotices;
    if (
      c.profile !== this.destination.profile ||
      c.chatId !== this.destination.chatId ||
      JSON.stringify(c.allowedSenderIds) !== JSON.stringify(this.destination.allowedSenderIds) ||
      c.nativeConfigFile !== this.destination.nativeConfigFile ||
      c.allowedSenderIds.length !== 1 ||
      !/^ou_[A-Za-z0-9_-]{1,160}$/.test(c.allowedSenderIds[0]) ||
      !o?.enabled ||
      o.checkpoints !== true ||
      !Array.isArray(o.targets) ||
      !Number.isFinite(Date.parse(o.enabledAt)) ||
      !Number.isFinite(Date.parse(o.checkpointEnabledAt)) ||
      Date.parse(o.checkpointEnabledAt) > this.now() ||
      !path.isAbsolute(o.checkpointStateFile ?? "") ||
      !o.checkpointStateFile.startsWith(path.dirname(this.configFile) + path.sep)
    )
      throw fail("CHECKPOINT_SCOPE_REVOKED");
    const n = readConfig(c.nativeConfigFile);
    if (
      n.managedCodex?.enabled !== true ||
      n.providers?.codex?.allowConversationPreview !== true ||
      n.loopHub?.configFile !== this.nativeConfig.loopHub?.configFile ||
      n.loopHub?.rulesFile !== this.nativeConfig.loopHub?.rulesFile ||
      [this.configFile, c.nativeConfigFile, n.controlsFile, n.loopHub.configFile, n.loopHub.rulesFile].includes(
        o.checkpointStateFile,
      ) ||
      Object.values(n.managedCodex.projectRoots ?? {}).some(
        (r) => o.checkpointStateFile === r || o.checkpointStateFile.startsWith(r + path.sep),
      )
    )
      throw fail("CHECKPOINT_SCOPE_REVOKED");
    const h = load(n.loopHub.configFile),
      rules = load(n.loopHub.rulesFile),
      entries = Object.entries(h.channels ?? {});
    if (entries.length !== 1 || Object.keys(rules.channels ?? {}).length !== 1) throw fail("CHECKPOINT_SCOPE_REVOKED");
    const [channel, settings] = entries[0];
    if (
      settings.use !== "feishu-group-text" ||
      settings.chatId !== c.chatId ||
      settings.profile !== c.profile ||
      !rules.channels[channel]?.answerers?.includes(c.allowedSenderIds[0])
    )
      throw fail("CHECKPOINT_SCOPE_REVOKED");
    if (event) {
      sourceScope(c, n, event);
      if (event.at < Date.parse(o.checkpointEnabledAt) || event.at > this.now()) throw fail("CHECKPOINT_STALE");
    }
    return { c, n, o, owner: c.allowedSenderIds[0] };
  }
  async sourceValid(event, settings) {
    if (this.validateSource) return (await this.validateSource(event, settings)) === true;
    const data = await this.readItems(
      settings.n,
      { projectKey: event.projectKey, threadId: event.threadId },
      { since: event.at, now: this.now(), through: { turnId: event.turnId, itemId: event.itemId } },
    );
    if (data.complete !== true) throw fail("CHECKPOINT_SOURCE_UNCONFIRMED");
    const item = data.items.find((i) => i.turnId === event.turnId && i.itemId === event.itemId);
    if (
      !item ||
      item.at !== event.at ||
      checkpointItemFingerprint(item) !== event.sourceHash ||
      !item.text.includes(event.evidence)
    )
      return false;
    return data.items
      .filter((i) => i.itemId !== event.itemId && i.at >= event.at && i.phase === "final_answer")
      .every((i) => stillPending(i, event));
  }
  async pending({ timeoutMs = 2500 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      return { projectKeys: [], complete: false };
    let s, rows;
    try {
      s = this.settings();
      const db = privateDatabase(s.o.checkpointStateFile, true);
      if (!db) return { projectKeys: [], complete: true };
      try {
        rows = db
          .prepare(
            "SELECT * FROM checkpoint_cards WHERE ref IS NOT NULL AND choice IS NULL AND state='open' ORDER BY created_at DESC LIMIT 11",
          )
          .all();
      } finally {
        db.close();
      }
    } catch {
      return { projectKeys: [], complete: false };
    }
    let complete = rows.length <= 10,
      expired = false,
      timer;
    const projects = new Set();
    const checks = rows.slice(0, 10).map(async (raw) => {
      try {
        const row = saved(raw);
        if (
          !refOK(row.ref) ||
          !Array.isArray(row.event.options) ||
          row.event.options.length < 2 ||
          row.event.options.length > 5 ||
          this.now() - row.event.at > 24 * 60 * 60000
        )
          return;
        let current;
        try {
          current = this.settings(row.event);
        } catch (e) {
          if (e.code === "CHECKPOINT_SCOPE_REVOKED" || e.code === "CHECKPOINT_STALE") return;
          throw e;
        }
        if (current.o.checkpointStateFile !== s.o.checkpointStateFile) throw fail("CHECKPOINT_SCOPE_CHANGED");
        const valid = await this.sourceValid(row.event, current);
        if (expired || !valid) return;
        this.settings(row.event);
        const db = privateDatabase(s.o.checkpointStateFile, true);
        if (!db) throw fail("CHECKPOINT_STATE_MISSING");
        try {
          const live = db.prepare("SELECT ref,state,choice,fingerprint FROM checkpoint_cards WHERE id=?").get(row.id);
          if (
            live?.ref === row.ref &&
            live.state === "open" &&
            live.choice === null &&
            live.fingerprint === row.fingerprint
          )
            projects.add(row.event.projectKey);
        } finally {
          db.close();
        }
      } catch {
        complete = false;
      }
    });
    try {
      await Promise.race([
        Promise.allSettled(checks),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            complete = false;
            resolve();
          }, timeoutMs);
        }),
      ]);
      return { projectKeys: [...projects], complete };
    } finally {
      clearTimeout(timer);
    }
  }
  render(row, owner) {
    const e = row.event,
      decision = Array.isArray(e.options),
      decided = row.choice !== null,
      expired = row.state === "expired";
    const card = {
      id: 1,
      version: row.display_version,
      ref: row.ref ?? null,
      kind: decision ? "ask" : "notice",
      state: decided ? "decided" : expired ? "closed" : "open",
      title: e.question,
      text: e.summary + (e.reason ? "\n推荐理由：" + e.reason : ""),
      options: e.options ?? [],
      recommend: e.recommend ?? null,
      choice: row.choice ?? null,
      answer: row.answer_text ?? null,
      result: null,
      link: null,
    };
    const out = decision ? renderDecisionCard(card, owner) : renderResultCard(card, owner);
    out.header.title.content = expired ? "问题已更新" : decided ? "选择已记录" : decision ? "需要你决定" : "需要你协助";
    if (decided) {
      const text =
        row.native_status === "queued"
          ? "已排到原对话，等待接收。"
          : row.native_status === "in-thread"
            ? "原对话已收到，等待回复。"
            : row.native_status === "completed"
              ? "原对话已回复这条交接。"
              : "交接结果暂未核实，选择已保留。";
      out.body.elements.push({ tag: "div", text: { tag: "plain_text", content: text } });
    }
    if (expired)
      out.body.elements.push({
        tag: "div",
        text: { tag: "plain_text", content: "原对话已有更新，请以最新进展为准。" },
      });
    const visit = (o) => {
      if (!o || typeof o !== "object") return;
      if (o.tag === "button" && /^pldecision_/.test(o.name ?? ""))
        o.name = `personalLoopCheckpoint_${row.id}_1_${o.name.endsWith("_help") ? "help" : "choice"}`;
      for (const b of o.behaviors ?? [])
        if (b.type === "callback" && b.value?.personalLoopDecision)
          b.value = { personalLoopCheckpoint: 1, id: row.id, version: 1, choice: b.value.choice };
      for (const v of Object.values(o)) if (v && typeof v === "object") visit(v);
    };
    visit(out);
    return out;
  }
  async call(c, args, body) {
    const result = await this.run(c.larkCommand ?? "lark-cli", ["--profile", c.profile, "im", ...args], {
      input: JSON.stringify(body),
      timeoutMs: 30000,
    });
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      throw fail("CHECKPOINT_DELIVERY_UNCONFIRMED");
    }
    if (result.exitCode !== 0 || response.ok !== true) throw fail("CHECKPOINT_DELIVERY_UNCONFIRMED");
    return response.data ?? {};
  }
  async deliver(event) {
    validateEvent(event);
    let s = this.settings(event);
    const id = digest([event.scope, event.eventKey]).slice(0, 40),
      fingerprint = digest(event);
    const db = privateDatabase(s.o.checkpointStateFile);
    try {
      let row = saved(db.prepare("SELECT * FROM checkpoint_cards WHERE id=?").get(id));
      if (row && row.fingerprint !== fingerprint) throw fail("CHECKPOINT_EVENT_CONFLICT");
      if (row?.ref) return { acknowledged: true, id };
      if (this.now() - event.at > 30 * 60000) return { acknowledged: false, code: "CHECKPOINT_STALE" };
      if (!(await this.sourceValid(event, s))) return { acknowledged: false, code: "CHECKPOINT_STALE" };
      s = this.settings(event);
      transaction(db, () => {
        db.prepare("INSERT OR IGNORE INTO checkpoint_cards(id,fingerprint,event_json,created_at) VALUES(?,?,?,?)").run(
          id,
          fingerprint,
          JSON.stringify(event),
          this.now(),
        );
        row = saved(db.prepare("SELECT * FROM checkpoint_cards WHERE id=?").get(id));
        if (row.fingerprint !== fingerprint) throw fail("CHECKPOINT_EVENT_CONFLICT");
        if (row.ref) return;
        if (row.send_lease > this.now()) throw fail("CHECKPOINT_SEND_PENDING");
        if (row.send_attempts >= 3 || (row.send_first_at !== null && this.now() - row.send_first_at > 30 * 60000))
          throw fail("CHECKPOINT_DELIVERY_UNCONFIRMED");
        db.prepare(
          "UPDATE checkpoint_cards SET send_attempts=send_attempts+1,send_first_at=COALESCE(send_first_at,?),send_lease=? WHERE id=?",
        ).run(this.now(), this.now() + 31000, id);
      });
      if (row.ref) return { acknowledged: true, id };
      const body = this.render(row, s.owner);
      const result = await this.call(
        s.c,
        [
          "+messages-send",
          "--chat-id",
          s.c.chatId,
          "--as",
          "bot",
          "--msg-type",
          "interactive",
          "--content",
          "-",
          "--idempotency-key",
          "pl-check-" + id,
        ],
        body,
      );
      if (!refOK(result.message_id) || (result.chat_id !== undefined && result.chat_id !== s.c.chatId))
        throw fail("CHECKPOINT_DELIVERY_UNCONFIRMED");
      db.prepare("UPDATE checkpoint_cards SET ref=?,send_lease=0 WHERE id=? AND ref IS NULL").run(
        result.message_id,
        id,
      );
      return { acknowledged: true, id };
    } finally {
      db.close();
    }
  }
  async patch(row, s) {
    this.settings(row.event);
    const result = await this.call(s.c, ["messages", "patch", "--message-id", row.ref, "--as", "bot", "--data", "-"], {
      content: JSON.stringify(this.render(row, s.owner)),
    });
    if (
      (result.message_id !== undefined && result.message_id !== row.ref) ||
      (result.chat_id !== undefined && result.chat_id !== s.c.chatId)
    )
      throw fail("CHECKPOINT_DELIVERY_UNCONFIRMED");
  }
  async handle(click) {
    const denied = (code, text = "这条选择与当前问题不符，请查看最新卡片。") => ({ ok: false, code, text });
    if (
      !click ||
      !idOK(click.id) ||
      click.version !== 1 ||
      !Number.isSafeInteger(click.choice) ||
      click.choice < 0 ||
      (click.answerText !== undefined && click.answerText !== "" && !validReply(click.answerText)) ||
      !refOK(click.messageId)
    )
      return denied("CHECKPOINT_INPUT_INVALID");
    let s;
    try {
      s = this.settings();
    } catch {
      return denied("CHECKPOINT_SCOPE_REVOKED");
    }
    if (
      click.actor !== s.owner ||
      (click.chat ?? click.chatId) !== s.c.chatId ||
      (click.profile !== undefined && click.profile !== s.c.profile)
    )
      return denied("CHECKPOINT_SCOPE_REVOKED");
    const db = privateDatabase(s.o.checkpointStateFile);
    try {
      let row = saved(db.prepare("SELECT * FROM checkpoint_cards WHERE id=?").get(click.id));
      if (
        !row ||
        !row.ref ||
        row.ref !== click.messageId ||
        !Array.isArray(row.event.options) ||
        click.choice >= row.event.options.length
      )
        return denied("CHECKPOINT_INPUT_INVALID");
      try {
        s = this.settings(row.event);
      } catch {
        return denied("CHECKPOINT_SCOPE_REVOKED");
      }
      if (requiresReply(row.event.options) && click.choice === 0 && !validReply(click.answerText))
        return denied("CHECKPOINT_REPLY_REQUIRED");
      if (row.state === "expired") return denied("CHECKPOINT_STALE");
      let first = false;
      if (row.choice === null) {
        if (this.now() - row.event.at > 24 * 60 * 60000 || !(await this.sourceValid(row.event, s))) {
          db.prepare(
            "UPDATE checkpoint_cards SET state='expired',display_version=display_version+1 WHERE id=? AND choice IS NULL",
          ).run(row.id);
          row = saved(db.prepare("SELECT * FROM checkpoint_cards WHERE id=?").get(row.id));
          await this.patch(row, s);
          return denied("CHECKPOINT_STALE");
        }
        s = this.settings(row.event);
        first = transaction(
          db,
          () =>
            db
              .prepare(
                "UPDATE checkpoint_cards SET choice=?,answer_text=?,answer_lease=?,state='decided',display_version=2 WHERE id=? AND choice IS NULL AND state='open'",
              )
              .run(click.choice, click.answerText?.trim() || null, this.now() + 31000, row.id).changes === 1,
        );
        row = saved(db.prepare("SELECT * FROM checkpoint_cards WHERE id=?").get(row.id));
      }
      if (!first && row.native_status === null && row.answer_lease > this.now())
        throw fail("CHECKPOINT_ANSWER_PENDING");
      const guard = () => {
        this.settings(row.event);
        const live = db.prepare("SELECT choice FROM checkpoint_cards WHERE id=?").get(row.id);
        if (live?.choice !== row.choice) throw fail("CHECKPOINT_STATE_CHANGED");
      };
      let status = row.native_status;
      if (!status || (status === "unknown" && !first)) {
        const input = {
          config: s.n,
          projectKey: row.event.projectKey,
          requestId: "checkpoint-answer:" + row.id,
          text:
            "大肥鱼转来你在飞书的选择。\n关于「" +
            row.event.question +
            "」，你选择了「" +
            row.event.options[row.choice] +
            "」。" +
            (row.answer_text ? "\n本人实际填写的回复：" + row.answer_text : "") +
            "\n请先核实这项选择仍适用于当前进展，再沿这个方向继续。此次选择只确认上述事项，其他操作仍遵照原对话的授权范围。",
          beforeMutation: guard,
        };
        const result = await (first ? this.queueBound : this.inspectBound)(input);
        guard();
        if (result.status === "queued") await wakeQueuedBoundChat(input).catch(() => {});
        status =
          result.threadId === row.event.threadId &&
          ["queued", "in-thread", "completed", "failed", "interrupted", "missing", "unknown"].includes(result.status)
            ? result.status
            : "unknown";
        db.prepare("UPDATE checkpoint_cards SET native_status=?,answer_lease=0 WHERE id=?").run(status, row.id);
        row = saved(db.prepare("SELECT * FROM checkpoint_cards WHERE id=?").get(row.id));
      }
      await this.patch(row, s);
      return { ok: true, status: status ?? "unknown", text: "选择已记录。" };
    } finally {
      db.close();
    }
  }
}
