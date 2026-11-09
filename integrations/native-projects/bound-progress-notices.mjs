// Observe one opted-in main chat. Legacy mode follows completed turns; checkpoint mode follows completed public messages.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifyBoundChat, boundChatClientId } from "./bound-chat.mjs";
import { ManagedCodexRpc } from "./managed-rpc.mjs";
import { readConfig } from "./factory.mjs";
import { redact } from "./project-activity.mjs";
import { pollCheckpointTarget } from "./checkpoint-monitor.mjs";

const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const load = (f) => JSON.parse(readFileSync(f, "utf8"));
const uuid = (v) => typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(v);
const safe = (v) =>
  typeof v === "string" &&
  v.trim() &&
  v.length <= 100 &&
  redact(v) === v &&
  !/[\p{Cc}\p{Cf}`<>{}|｜@\\/]|https?:|\b(?:ou|oc|om|omt)_[A-Za-z0-9_-]+|\b\d{7,}\b|[a-f\d]{16,}|(?:密码|密钥|凭证|保密|不公开|不要.{0,3}通知)/iu.test(
    v,
  );
const categories = [
  ["decision", /^(?:需要你拍板|需要你决定|请你决定|待你确认)[：:]\s*(.{3,90})$/u, "需要你作决定"],
  ["blocker", /^(?:当前受阻|受阻|当前阻塞|暂时无法继续|执行失败)[：:]\s*(.{3,90})$/u, "遇到阻塞，可能需要你处理"],
  ["milestone", /^(?:已交付|交付完成|通过验收|已通过验收|已上线|已发布)[：:]\s*(.{3,90})$/u, "报告已有新的交付结果"],
];
// Only a current, explicit dependency on the reader qualifies. Emit a fixed action, never private reply text.
function humanBlocker(body) {
  if (body.length > 32000) return null;
  const lines = body
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.trim());
  const line = lines.at(-1)?.trim();
  if (
    !line ||
    line.length > 180 ||
    /[>`「」“”]|(?:例如|示例|假设|如果|历史|此前|之前|以前|曾经|已(?:经)?(?:解决|收到|恢复)|可以继续|先继续|不(?:用|要|必)|无需)/u.test(
      line,
    )
  )
    return null;
  // Do not lift a sentence from an example, a quote, or an unclosed fenced block.
  const prefix = lines.slice(0, -1).join("\n");
  if (/([：:>]|(?:例如|示例|原话|历史记录)[。.]?)\s*$/u.test(prefix) || (prefix.match(/```/gu)?.length ?? 0) % 2)
    return null;
  const request =
    /(?:请(?:你|您)?|麻烦(?:你|您)|需要(?:你|您|本人))\s*(?:先|帮我|帮忙|协助)?\s*(补充|提供|上传|指定|联系|开通|授权|批准|确认|选择)(.{1,75})/u.exec(
      line,
    );
  if (
    !request ||
    !safe(request[1] + request[2]) ||
    !/(?:缺少|欠缺|还缺|没有(?:访问)?权限|无法(?:继续|访问|登录)|才能(?:继续|完成|核对|开始)|尚不能继续)/u.test(line)
  )
    return null;
  const verb = request[1];
  let sentence;
  if (/^(?:开通|授权|批准)$/u.test(verb) || /(?:权限|授权|访问资格)/u.test(request[2]))
    sentence = "原聊天受权限限制。请在原系统核对所需授权，再回原对话说明。";
  else if (/^(?:补充|提供|上传)$/u.test(verb))
    sentence = "原聊天缺少所需资料。请在原对话补充可用资料或说明从哪里获取。";
  else if (/^(?:指定|联系)$/u.test(verb) && /(?:人选|同事|负责人|谁|对接人)/u.test(request[2]))
    sentence = "原聊天需要有人对接。请在原对话指定负责这件事的同事。";
  else if (/^(?:确认|选择)$/u.test(verb)) sentence = "原聊天需要你确认一个条件才能继续。请回原对话查看并决定。";
  if (!sentence) return null;
  return {
    kind: "blocker",
    sentence,
    fingerprint: hash(["owner-blocker", line.normalize("NFKC").replace(/[\s\p{P}]/gu, "")]),
  };
}
export function noticeSignal(turn) {
  if (!turn || turn.status !== "completed" || turn.itemsView !== "full" || !Array.isArray(turn.items)) return null;
  const users = turn.items.filter((i) => i?.type === "userMessage");
  const finals = turn.items.filter((i) => i?.type === "agentMessage" && i.phase === "final_answer");
  if (
    users.length !== 1 ||
    finals.length !== 1 ||
    turn.items.indexOf(finals[0]) < turn.items.indexOf(users[0]) ||
    !Array.isArray(users[0].content) ||
    !users[0].content.some((i) => i.type === "text" && typeof i.text === "string" && i.text.trim()) ||
    users[0].content.some(
      (i) =>
        typeof i?.text === "string" &&
        (/(?:大肥鱼从飞书接到这个目标|大肥鱼把.{0,120}交接回这条主对话)/u.test(i.text) ||
          /^大肥鱼(?:续办(?:\n|$)|接续目标：)/u.test(i.text)),
    ) ||
    typeof finals[0].text !== "string"
  )
    return null;
  if (/(?:不要|不必|不用|无需|请勿).{0,6}(?:通知|转发|发群)/u.test(finals[0].text)) return null;
  const blocker = humanBlocker(finals[0].text);
  if (blocker) return { ...blocker, clientId: users[0].clientId ?? null };
  const line = finals[0].text
    .trimStart()
    .split(/\r?\n/u, 1)[0]
    .trim()
    .replace(/^\*\*([^*]+)\*\*$/u, "$1");
  for (const [kind, pattern, summary] of categories) {
    if (
      kind !== "milestone" &&
      /(?:已(?:经)?(?:解决|恢复|收到)|可以继续|无需(?:处理|确认))/u.test(finals[0].text.trim().split(/\r?\n/u).at(-1))
    )
      continue;
    const match = pattern.exec(line),
      detail = match?.[1]?.trim();
    if (!safe(detail) || /(?:例如|举例|示例|假设|假如|并未|尚未交付|待交付|还未交付|模拟|测试消息)/u.test(detail))
      continue;
    // Never forward the raw headline: even short, well-formed user/customer names or internal figures may be private.
    const topic = /(?:试用|导航|验收|权限|安装|设计|方案|资料|交付)/u.exec(detail)?.[0];
    const sentence = topic ? "原聊天关于" + topic + "的事项" + summary + "。" : "原聊天" + summary + "。";
    return {
      kind,
      sentence,
      fingerprint: hash([kind, detail.normalize("NFKC").replace(/[\s\p{P}]/gu, "")]),
      clientId: users[0].clientId ?? null,
    };
  }
  return null;
}
function privateFile(file, allowMissing = false) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw Error("Invalid private file");
  const dir = path.dirname(file),
    stat = lstatSync(dir);
  if (realpathSync(dir) !== dir || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
    throw Error("Private directory required");
  let st;
  try {
    st = lstatSync(file);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return;
    throw error;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0)
    throw Error("Unverified private file");
}
function ownHandoff(native, clientId) {
  if (!clientId) return false;
  const file = path.join(native.managedCodex.stateDir, "bound-chat.db");
  privateFile(file, true);
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return !!db.prepare("SELECT 1 FROM intents WHERE id=?").get(clientId);
  } finally {
    db.close();
  }
}
// Match the exact queued message to a normal worker request and its pinned route.
// A manual or checkpoint-answer message does not inherit this decision channel.
function hasManagedDecisionOwner(native, target, item) {
  if (!Array.isArray(item.clientIds) || !item.clientIds.length) return false;
  const binding = native.managedCodex.boundChats?.[target.projectKey];
  if (binding?.threadId !== target.threadId) return false;
  const workerFile = path.join(native.managedCodex.stateDir, hash(target.projectKey), "worker.db");
  const queueFile = path.join(native.managedCodex.stateDir, "bound-chat.db");
  if (!existsSync(workerFile) || !existsSync(queueFile)) return false;
  privateFile(workerFile);
  privateFile(queueFile);
  const ledger = new DatabaseSync(workerFile, { readOnly: true });
  const queue = new DatabaseSync(queueFile, { readOnly: true });
  try {
    ledger.exec("PRAGMA query_only=ON");
    queue.exec("PRAGMA query_only=ON");
    const route = JSON.stringify([binding.threadId, binding.projectId, binding.root]);
    const rows = ledger
      .prepare(
        "SELECT r.run_id,r.request_id FROM requests r JOIN bound_routes b ON b.goal_id=r.goal_id WHERE b.binding=? AND r.request_id LIKE 'native-run:%'",
      )
      .all(route);
    return rows.some((row) => {
      if (row.request_id !== "native-run:" + row.run_id) return false;
      const id = boundChatClientId(target.projectKey, row.request_id);
      return item.clientIds.includes(id) && !!queue.prepare("SELECT 1 FROM intents WHERE id=?").get(id);
    });
  } finally {
    queue.close();
    ledger.close();
  }
}
// Suppress only an exact final answer whose normal bound-worker receipt already created its own result notice.
function hasResultNotice(native, target, item) {
  const dir = path.join(native.managedCodex.stateDir, hash(target.projectKey));
  const file = path.join(dir, "worker.db");
  if (!existsSync(file)) return false;
  privateFile(file);
  const ledger = new DatabaseSync(file, { readOnly: true });
  let matches;
  try {
    ledger.exec("PRAGMA query_only=ON");
    matches = ledger
      .prepare(
        "SELECT run_id FROM requests WHERE json_extract(result,'$.coordinator.action')='deliver' AND json_extract(result,'$.coordinator.threadId')=? AND json_extract(result,'$.coordinator.turnId')=?",
      )
      .all(target.threadId, item.turnId);
  } finally {
    ledger.close();
  }
  if (!matches.length) return false;
  const fileHub = path.join(path.dirname(native.loopHub.configFile), "hub.db");
  if (!existsSync(fileHub)) return false;
  privateFile(fileHub);
  const hub = new DatabaseSync(fileHub, { readOnly: true });
  try {
    hub.exec("PRAGMA query_only=ON");
    const key = "native-project:" + createHash("sha256").update(target.projectKey).digest("hex");
    const query = hub.prepare(
      "SELECT 1 FROM projections WHERE collection='cards' AND json_extract(data,'$.rule')=? AND json_extract(data,'$.run_id')=? AND json_extract(data,'$.kind')='notice' AND json_extract(data,'$.key') LIKE '%:bound-result-%' LIMIT 1",
    );
    return matches.some((row) => query.get(key, Number(row.run_id.split(":")[0])));
  } finally {
    hub.close();
  }
}
async function recent(native, target, cursor) {
  const client = new ManagedCodexRpc({ command: native.managedCodex.command, timeoutMs: 4000 });
  const verify = async () => {
    const result = await verifyBoundChat({ config: native, projectKey: target.projectKey, client });
    if (result.status !== "verified" || result.threadId !== target.threadId) throw Error("Binding unavailable");
  };
  try {
    await verify();
    const args = { threadId: target.threadId, limit: 4, sortDirection: "desc", itemsView: "notLoaded" };
    const page = await client.request("thread/turns/list", args);
    if (!Array.isArray(page?.data)) throw Error("Invalid history");
    const rows = page.data.filter((t) => t?.status === "completed" && typeof t.id === "string" && t.id);
    if (!rows.length && page.nextCursor) throw Error("Completed history not covered");
    if (!rows.length || cursor === null || hash(rows[0].id) === cursor) return rows;
    const boundary = rows.findIndex((t) => hash(t.id) === cursor);
    if (boundary < 0 && cursor !== "") return rows; // A history gap is a new baseline; do not reconstruct missed notifications.
    const wanted = new Set((boundary < 0 ? rows : rows.slice(0, boundary)).map((t) => t.id));
    if (!wanted.size) return rows;
    const turns = await client.request("thread/turns/list", { ...args, itemsView: "full" });
    if (
      !Array.isArray(turns?.data) ||
      turns.data.length !== page.data.length ||
      !turns.data.every((t, i) => t.id === page.data[i].id && t.status === page.data[i].status)
    )
      throw Error("History changed");
    await verify();
    return turns.data.filter((t) => t.status === "completed");
  } finally {
    await client.close();
  }
}
function store(file) {
  privateFile(file, true);
  const db = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    db.exec(
      "PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000;CREATE TABLE IF NOT EXISTS checkpoints(scope TEXT PRIMARY KEY, last TEXT NOT NULL);CREATE TABLE IF NOT EXISTS notices(key TEXT PRIMARY KEY,card INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS notice_scopes(key TEXT PRIMARY KEY,scope TEXT NOT NULL);",
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export class BoundProgressNotices {
  constructor({
    configFile,
    config,
    nativeConfig,
    runtime,
    now = Date.now,
    readRecent = recent,
    readItems,
    classifyCheckpoint,
    onCheckpoint,
  }) {
    Object.assign(this, {
      configFile,
      config,
      nativeConfig,
      runtime,
      now,
      readRecent,
      readItems,
      classifyCheckpoint,
      onCheckpoint,
    });
    this.abort = new AbortController();
    this.next = 0;
    this.stopped = false;
    this.flight = null;
  }
  settings() {
    const c = load(this.configFile),
      o = c.proactiveNotices;
    if (
      c.nativeConfigFile !== this.config.nativeConfigFile ||
      c.profile !== this.config.profile ||
      c.chatId !== this.config.chatId ||
      JSON.stringify(c.allowedSenderIds) !== JSON.stringify(this.config.allowedSenderIds) ||
      !o ||
      o.enabled !== true ||
      (o.checkpoints !== undefined && typeof o.checkpoints !== "boolean") ||
      (o.checkpoints === true &&
        (!Number.isFinite(Date.parse(o.checkpointEnabledAt)) || Date.parse(o.checkpointEnabledAt) > this.now())) ||
      !Number.isFinite(Date.parse(o.enabledAt)) ||
      Date.parse(o.enabledAt) > this.now() ||
      !Number.isInteger(o.intervalMs ?? 60000) ||
      (o.intervalMs ?? 60000) < 15000 ||
      (o.intervalMs ?? 60000) > 1800000 ||
      !path.isAbsolute(o.stateFile ?? "") ||
      !Array.isArray(o.targets) ||
      !o.targets.length ||
      o.targets.length > 3
    )
      return null;
    const n = c.nativeConfigFile ? readConfig(c.nativeConfigFile) : this.nativeConfig;
    if (
      n?.managedCodex?.enabled !== true ||
      n.providers?.codex?.allowConversationPreview !== true ||
      n.loopHub?.configFile !== this.nativeConfig.loopHub?.configFile ||
      n.loopHub?.rulesFile !== this.nativeConfig.loopHub?.rulesFile ||
      [this.configFile, c.nativeConfigFile, n.loopHub.configFile, n.loopHub.rulesFile].includes(o.stateFile) ||
      !o.stateFile.startsWith(path.dirname(this.configFile) + path.sep) ||
      Object.values(n.managedCodex.projectRoots ?? {}).some(
        (root) => root === o.stateFile || o.stateFile.startsWith(root + path.sep),
      )
    )
      return null;
    const hc = load(n.loopHub.configFile),
      rules = load(n.loopHub.rulesFile);
    const channels = Object.entries(hc.channels ?? {}),
      ruleKeys = Object.keys(rules.channels ?? {});
    if (channels.length !== 1 || ruleKeys.length !== 1 || channels[0][0] !== ruleKeys[0]) return null;
    const [dest, chan] = channels[0];
    if (
      chan.use !== "feishu-group-text" ||
      chan.profile !== c.profile ||
      chan.chatId !== c.chatId ||
      !Array.isArray(rules.channels[dest]?.answerers) ||
      !Array.isArray(c.allowedSenderIds) ||
      c.allowedSenderIds.length !== 1 ||
      !rules.channels[dest].answerers.includes(c.allowedSenderIds[0])
    )
      return null;
    return { o, n };
  }
  async poll() {
    const setting = this.settings();
    if (!setting) return { status: "disabled" };
    const { o, n } = setting;
    this.next = this.now() + (o.intervalMs ?? 60000);
    let baselined = 0,
      sent = 0;
    for (const target of o.targets) {
      if (this.stopped) break;
      const { projectKey, threadId, projectName } = target ?? {};
      const b = n.managedCodex.boundChats?.[projectKey];
      if (
        !safe(projectName) ||
        !uuid(threadId) ||
        !b ||
        b.threadId !== threadId ||
        b.root !== n.managedCodex.projectRoots?.[projectKey] ||
        !n.managedCodex.coordinatorProjectKeys?.includes(projectKey) ||
        projectKey !== "codex:local:" + encodeURIComponent(b.projectId)
      )
        continue;
      const scope = hash([this.config.profile, this.config.chatId, o.enabledAt, projectKey, b]);
      const db = store(o.stateFile);
      try {
        if (o.checkpoints === true) {
          const guard = () => {
            const fresh = this.settings();
            if (
              this.stopped ||
              !fresh ||
              fresh.o.checkpoints !== true ||
              fresh.o.checkpointEnabledAt !== o.checkpointEnabledAt ||
              fresh.o.enabledAt !== o.enabledAt ||
              fresh.o.stateFile !== o.stateFile ||
              !fresh.o.targets.some(
                (t) => t.projectKey === projectKey && t.threadId === threadId && t.projectName === projectName,
              ) ||
              JSON.stringify(fresh.n.managedCodex.boundChats?.[projectKey]) !== JSON.stringify(b)
            )
              throw Error("Checkpoint authority changed");
          };
          const result = await pollCheckpointTarget({
            db,
            o,
            n,
            target,
            scope,
            now: this.now,
            guard,
            runtime: this.runtime,
            onCheckpoint: this.onCheckpoint,
            readItems: this.readItems,
            classify: this.classifyCheckpoint,
            signal: this.abort.signal,
            hasResultNotice,
            hasManagedDecisionOwner,
          });
          baselined += result.baselined;
          sent += result.sent;
          continue;
        }
        const cursor = db.prepare("SELECT last FROM checkpoints WHERE scope=?").get(scope)?.last ?? null;
        const turns = await this.readRecent(n, target, cursor);
        if (
          !Array.isArray(turns) ||
          turns.some((x) => !x || typeof x.id !== "string" || !x.id || x.status !== "completed")
        )
          continue;
        const head = turns.length ? hash(turns[0].id) : "";
        const boundary = turns.findIndex((t) => hash(t.id) === cursor);
        if (cursor === head || (!head && cursor)) continue;
        const checkpoint = (value) =>
          db
            .prepare("INSERT INTO checkpoints VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET last=excluded.last")
            .run(scope, value);
        if (cursor === null || (cursor !== "" && boundary < 0)) {
          if (this.stopped) break;
          checkpoint(head);
          baselined++;
          continue;
        }
        for (const t of turns.slice(0, boundary < 0 ? turns.length : boundary).reverse()) {
          if (this.stopped) break;
          const completed = Number.isFinite(t.completedAt) ? t.completedAt * 1000 : NaN;
          const signal =
            completed >= Date.parse(o.enabledAt) && completed <= this.now() && this.now() - completed <= 30 * 60000
              ? noticeSignal(t)
              : null;
          if (signal && !ownHandoff(n, signal.clientId)) {
            const id = "progress-" + hash([scope, signal.fingerprint]).slice(0, 48);
            if (!db.prepare("SELECT 1 FROM notices WHERE key=?").get(id)) {
              const fresh = this.settings();
              if (
                this.stopped ||
                !fresh ||
                fresh.o.stateFile !== o.stateFile ||
                fresh.o.enabledAt !== o.enabledAt ||
                !fresh.o.targets.some(
                  (x) => x?.projectKey === projectKey && x.threadId === threadId && x.projectName === projectName,
                ) ||
                JSON.stringify(fresh.n.managedCodex.boundChats?.[projectKey]) !== JSON.stringify(b)
              )
                return { status: "revoked" };
              const result = await this.runtime
                .layout()
                .source.tell({ key: id, text: "「" + projectName + "」" + signal.sentence });
              if (!Number.isInteger(result?.card) || result.card <= 0) throw Error("Unconfirmed notice");
              db.exec("BEGIN IMMEDIATE");
              try {
                db.prepare("INSERT OR IGNORE INTO notices VALUES(?,?)").run(id, result.card);
                db.prepare("INSERT OR IGNORE INTO notice_scopes VALUES(?,?)").run(id, scope);
                db.exec("COMMIT");
              } catch (error) {
                if (db.isTransaction) db.exec("ROLLBACK");
                throw error;
              }
              sent++;
            }
          }
          checkpoint(hash(t.id));
        }
      } finally {
        db.close();
      }
    }
    return { status: "checked", baselined, sent };
  }
  tick() {
    if (this.flight) return this.flight;
    if (this.stopped || this.now() < this.next) return Promise.resolve({ status: "idle" });
    this.next = this.now() + 60000;
    this.flight = this.poll()
      .catch(() => ({ status: "unavailable" }))
      .finally(() => {
        this.flight = null;
      });
    return this.flight;
  }
  pulse() {
    void this.tick();
  }
  async stop() {
    this.stopped = true;
    this.abort.abort();
    if (this.flight) await this.flight;
  }
}

// A source FYI has no native rule. Recover its identity only from the watcher's acknowledged local receipt.
export function verifiedNoticeProject({ configFile, config, nativeConfig, sourceKey, cardId }) {
  if (!configFile || !Number.isSafeInteger(cardId) || cardId < 1) return null;
  const setting = new BoundProgressNotices({ configFile, config, nativeConfig }).settings();
  if (!setting) return null;
  const { o, n } = setting;
  const source = load(n.loopHub.configFile).source?.name;
  if (typeof source !== "string" || typeof sourceKey !== "string" || !sourceKey.startsWith("source:" + source + ":"))
    return null;
  const key = sourceKey.slice(("source:" + source + ":").length);
  if (!/^(?:progress|checkpoint)-[a-f0-9]{48}$/u.test(key)) return null;
  privateFile(o.stateFile);
  const db = new DatabaseSync(o.stateFile, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const row = db
      .prepare("SELECT s.scope FROM notices n JOIN notice_scopes s ON s.key=n.key WHERE n.key=? AND n.card=?")
      .get(key, cardId);
    if (!row) return null;
    const targets = o.targets.filter((t) => {
      const b = n.managedCodex.boundChats?.[t?.projectKey];
      return (
        b &&
        t.threadId === b.threadId &&
        uuid(t.threadId) &&
        safe(t.projectName) &&
        n.managedCodex.coordinatorProjectKeys?.includes(t.projectKey) &&
        b.root === n.managedCodex.projectRoots?.[t.projectKey] &&
        t.projectKey === "codex:local:" + encodeURIComponent(b.projectId) &&
        hash([config.profile, config.chatId, o.enabledAt, t.projectKey, b]) === row.scope
      );
    });
    return targets.length === 1 ? targets[0].projectKey : null;
  } finally {
    db.close();
  }
}
