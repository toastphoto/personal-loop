import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
  existsSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import { ManagedCodexRpc, ManagedCodexError } from "./managed-rpc.mjs";

const now = () => new Date().toISOString();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message) => {
  throw new ManagedCodexError(code, message);
};
const id = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    fail("MANAGED_INVALID_INPUT", "需要明确的原生编号");
};
const status = (thread) => (typeof thread.status === "string" ? thread.status : thread.status?.type);
const terminal = new Set(["completed", "failed", "interrupted"]);
const guardCheck = (fn) => {
  if (typeof fn !== "function") fail("MANAGED_GUARD_REQUIRED", "执行前必须有同步项目授权和运行状态检查");
};
const check = (fn) => {
  const result = fn();
  if (result && typeof result.then === "function") {
    result.catch?.(() => {});
    fail("MANAGED_GUARD_REQUIRED", "执行前检查必须同步完成");
  }
};
const safeUsage = (value) =>
  Object.fromEntries(
    [
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ]
      .filter((k) => Number.isSafeInteger(value?.[k]) && value[k] >= 0)
      .map((k) => [k, value[k]]),
  );

// Native "last" describes one provider request, not an entire agent turn.
const usageBasis = (session, fresh) => {
  if (fresh)
    return {
      values: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      source: "fresh-owned-zero",
      turnId: null,
    };
  if (
    session.lastCompletion?.turnId &&
    session.usage?.turnId === session.lastCompletion.turnId &&
    session.usage.total
  ) {
    return { values: safeUsage(session.usage.total), source: "previous-completed-total", turnId: session.usage.turnId };
  }
  return { values: null, source: "missing", turnId: null };
};

export class ManagedCodexExecutor {
  constructor(options = {}) {
    if (!options.stateFile || !path.isAbsolute(options.stateFile))
      fail("MANAGED_CONFIG_ERROR", "需要明确的私有账本绝对路径");
    this.options = options;
    this.enabled = options.enabled === true;
    this.closed = false;
    this.busy = false;
    this.results = new Map();
    this.waiters = new Map();
    this.pendingStartThread = null;
    this.freshThreads = new Map();
    this.sandbox = options.sandbox ?? "read-only";
    if (!["read-only", "workspace-write"].includes(this.sandbox))
      fail("MANAGED_CONFIG_ERROR", "受管执行只允许只读或限定工作目录权限");
    this.file = options.stateFile;
    this.lockFile = this.file + ".lease";
    this.nonce = randomUUID();
    const parent = path.dirname(this.file);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    for (const file of [this.file, this.lockFile])
      if (existsSync(file) && lstatSync(file).isSymbolicLink())
        fail("MANAGED_CONFIG_ERROR", "私有账本不能使用符号链接");
    if (options.recoverStaleLease === true && existsSync(this.lockFile)) {
      let lease;
      try {
        lease = JSON.parse(readFileSync(this.lockFile, "utf8"));
      } catch {
        fail("MANAGED_LOCK_UNCERTAIN", "原进程归属无法核实");
      }
      const alive = (pid) => {
        if (!Number.isSafeInteger(pid) || pid <= 0) return true;
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return error.code !== "ESRCH";
        }
      };
      if (alive(lease.pid) || (lease.childPid && alive(lease.childPid)))
        fail("MANAGED_ALREADY_OWNED", "原受管进程仍可能在运行");
      unlinkSync(this.lockFile);
    }
    try {
      const fd = openSync(this.lockFile, "wx", 0o600);
      closeSync(fd);
    } catch (error) {
      if (error.code === "EEXIST") fail("MANAGED_ALREADY_OWNED", "此执行账本已有进程持有，不能并行接管");
      throw error;
    }
    this.writeLease(null);
    try {
      this.db = new DatabaseSync(this.file);
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS owned_sessions(goal_id TEXT PRIMARY KEY, thread_id TEXT UNIQUE, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owned_operations(request_id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owned_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);",
      );
      chmodSync(this.file, 0o600);
      for (const suffix of ["-wal", "-shm"]) if (existsSync(this.file + suffix)) chmodSync(this.file + suffix, 0o600);
      // In-flight intents survive process death; they are never silently replayed.
      for (const session of this.sessions())
        if (["creating", "starting", "running", "stopping"].includes(session.state))
          this.putSession({ ...session, state: "unknown", reason: "previous-process-ended" });
      const callbacks = {
        onNotification: (m, p) => this.handleEvent(m, p),
        onDisconnect: (code) => this.disconnected(code),
        onSpawn: (pid) => this.writeLease(pid),
      };
      this.transport =
        options.transportFactory?.(callbacks) ??
        new ManagedCodexRpc({ command: options.command, timeoutMs: options.timeoutMs, ...callbacks });
    } catch (error) {
      this.db?.close();
      this.releaseLease();
      throw error;
    }
  }

  writeLease(childPid) {
    writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, childPid: childPid ?? null, nonce: this.nonce }), {
      mode: 0o600,
    });
  }
  releaseLease() {
    try {
      const lease = JSON.parse(readFileSync(this.lockFile, "utf8"));
      if (lease.nonce === this.nonce) unlinkSync(this.lockFile);
    } catch {}
  }
  assertOpen() {
    if (this.closed) fail("MANAGED_CLOSED", "受管执行器已关闭");
  }
  assertEnabled() {
    this.assertOpen();
    if (!this.enabled) fail("MANAGED_DISABLED", "受管自动执行尚未启用");
  }
  sessions() {
    return this.db
      .prepare("SELECT data FROM owned_sessions")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  sessionByGoal(goalId) {
    const row = this.db.prepare("SELECT data FROM owned_sessions WHERE goal_id=?").get(goalId);
    return row ? JSON.parse(row.data) : null;
  }
  owned(threadId) {
    this.assertOpen();
    id(threadId);
    const row = this.db.prepare("SELECT data FROM owned_sessions WHERE thread_id=?").get(threadId);
    if (!row) fail("MANAGED_NOT_OWNED", "此线程不是本loop创建登记的会话");
    return JSON.parse(row.data);
  }
  putSession(s) {
    s.updatedAt = now();
    this.db
      .prepare(
        "INSERT INTO owned_sessions(goal_id,thread_id,data) VALUES(?,?,?) ON CONFLICT(goal_id) DO UPDATE SET thread_id=excluded.thread_id,data=excluded.data",
      )
      .run(s.goalId, s.threadId ?? null, JSON.stringify(s));
    return s;
  }
  op(key) {
    const row = this.db.prepare("SELECT data FROM owned_operations WHERE request_id=?").get(key);
    return row ? JSON.parse(row.data) : null;
  }
  putOp(op) {
    op.updatedAt = now();
    this.db
      .prepare(
        "INSERT INTO owned_operations(request_id,data) VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET data=excluded.data",
      )
      .run(op.requestId, JSON.stringify(op));
    return op;
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async exclusive(fn) {
    this.assertOpen();
    if (this.busy) fail("MANAGED_BUSY", "本执行器已有原生操作进行中");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  async rpc(method, params) {
    await this.transport.connect();
    return this.transport.request(method, params);
  }
  async mutate(method, params, beforeMutation, issued) {
    await this.transport.connect();
    check(beforeMutation);
    issued();
    return this.transport.request(method, params);
  }
  metadata(s) {
    return {
      mode: "managed-executor",
      owned: true,
      goalId: s.goalId,
      nativeId: s.threadId,
      projectId: s.projectId,
      cwd: s.cwd,
      state: s.state,
      activeTurnId: s.activeTurnId ?? null,
      sandbox: s.sandbox,
      updatedAt: s.updatedAt,
      lastCompletion: s.lastCompletion ?? null,
      usage: s.usage ?? null,
      completionVerified: s.state === "idle" && !!s.lastCompletion,
    };
  }
  assertIdentity(thread, s) {
    if (thread?.id !== s.threadId || thread.projectId !== s.projectId || path.resolve(thread.cwd ?? "/") !== s.cwd)
      fail("MANAGED_IDENTITY_MISMATCH", "原生线程身份、项目或目录与所有权记录不符");
  }
  assertIdle(thread) {
    if (!["idle", "notLoaded"].includes(status(thread)) || thread.canAcceptDirectInput === false)
      fail("MANAGED_NOT_IDLE", "受管会话正忙或不可接受输入");
  }

  async createOwnedSession({ projectId, cwd, goalId, goal, beforeMutation } = {}) {
    this.assertEnabled();
    id(projectId);
    id(goalId);
    guardCheck(beforeMutation);
    if (
      typeof cwd !== "string" ||
      !path.isAbsolute(cwd) ||
      typeof goal !== "string" ||
      !goal.trim() ||
      goal.length > 100_000
    )
      fail("MANAGED_INVALID_INPUT", "创建受管会话需要具体项目、绝对工作目录和明确目标");
    cwd = path.resolve(cwd);
    const fingerprint = hash([projectId, cwd, goal, this.sandbox]);
    return this.exclusive(async () => {
      const prior = this.sessionByGoal(goalId);
      if (prior && prior.fingerprint !== fingerprint)
        fail("MANAGED_REQUEST_CONFLICT", "同一目标编号不能改成其他项目或目标");
      if (prior?.threadId) return this.metadata(prior);
      if (prior && prior.state !== "not-created")
        fail("MANAGED_OUTCOME_UNKNOWN", "此前创建结果不确定，不能自动再建会话");
      const project = (await this.rpc("project/read", { projectId }))?.project;
      if (project?.id !== projectId || !project.roots?.some((r) => path.resolve(r.path) === cwd))
        fail("MANAGED_PROJECT_SCOPE", "目标目录不是该原生项目的已确认根目录");
      const session = {
        goalId,
        projectId,
        cwd,
        fingerprint,
        sandbox: this.sandbox,
        state: "creating",
        threadId: null,
        createdAt: now(),
      };
      const operation = {
        requestId: "create:" + goalId,
        kind: "create",
        goalId,
        fingerprint,
        state: "intent",
        createdAt: now(),
      };
      this.transaction(() => {
        this.putSession(session);
        this.putOp(operation);
      });
      let issued = false;
      try {
        const response = await this.mutate(
          "thread/start",
          {
            projectId,
            cwd,
            ephemeral: false,
            sandbox: this.sandbox,
            approvalPolicy: "never",
            runtimeWorkspaceRoots: [cwd],
            threadSource: "personal-loop",
          },
          beforeMutation,
          () => {
            issued = true;
          },
        );
        const thread = response?.thread;
        id(thread?.id);
        if (thread.projectId !== projectId || path.resolve(thread.cwd ?? "/") !== cwd)
          fail("MANAGED_IDENTITY_MISMATCH", "新线程没有绑定已选原生项目");
        this.assertIdle(thread);
        session.threadId = thread.id;
        session.state = "idle";
        this.transaction(() => {
          this.putSession(session);
          this.putOp({ ...operation, state: "accepted", threadId: thread.id });
        });
        // A freshly created empty thread may not yet have a durable read/resume projection.
        this.freshThreads.set(thread.id, { goalId, projectId, cwd, fingerprint });
        return this.metadata(session);
      } catch (error) {
        this.transaction(() => {
          this.putSession({
            ...session,
            threadId: null,
            state: issued ? "unknown" : "not-created",
            reason: error.code ?? "error",
          });
          this.putOp({ ...operation, state: issued ? "unknown" : "blocked", errorCode: error.code ?? "error" });
        });
        throw error;
      }
    });
  }

  async continueOwned({ threadId, requestId, text, beforeMutation } = {}) {
    this.assertEnabled();
    id(requestId);
    guardCheck(beforeMutation);
    if (typeof text !== "string" || !text.trim() || text.length > 100_000)
      fail("MANAGED_INVALID_INPUT", "续办内容为空或过长");
    return this.exclusive(async () => {
      const s = this.owned(threadId),
        fingerprint = hash(["continue", threadId, text]);
      const prior = this.op(requestId);
      if (prior && prior.fingerprint !== fingerprint) fail("MANAGED_REQUEST_CONFLICT", "请求编号已用于不同内容");
      if (prior?.state === "accepted" || prior?.state === "completed")
        return {
          accepted: true,
          completionVerified: prior.state === "completed",
          nativeId: threadId,
          executionId: prior.turnId,
          requestId,
        };
      if (prior && prior.state !== "blocked") fail("MANAGED_OUTCOME_UNKNOWN", "原请求结果未知，不会再次发送");
      if (s.state !== "idle")
        fail(s.state === "unknown" ? "MANAGED_OUTCOME_UNKNOWN" : "MANAGED_NOT_IDLE", "受管会话尚未确认空闲");
      const hasTurnIntent = !!this.db
        .prepare(
          "SELECT 1 FROM owned_operations WHERE json_extract(data,'$.kind')='continue' AND json_extract(data,'$.threadId')=? LIMIT 1",
        )
        .get(threadId);
      const cached = this.freshThreads.get(threadId);
      const fresh = !hasTurnIntent && !!cached;
      if (
        cached &&
        (cached.goalId !== s.goalId ||
          cached.projectId !== s.projectId ||
          cached.cwd !== s.cwd ||
          cached.fingerprint !== s.fingerprint)
      )
        fail("MANAGED_IDENTITY_MISMATCH", "当前Host的新线程身份与持久所有权记录不符");
      if (!hasTurnIntent && !fresh)
        fail("MANAGED_EMPTY_SESSION_UNCONFIRMED", "空线程已离开创建它的Host；未确认持久化，不会重建或自动重发");
      if (!fresh) {
        const current = (await this.rpc("thread/read", { threadId, includeTurns: false }))?.thread;
        this.assertIdentity(current, s);
        this.assertIdle(current);
      }
      const usageBaseline = usageBasis(this.owned(threadId), fresh);
      const operation = {
        requestId,
        kind: "continue",
        goalId: s.goalId,
        threadId,
        fingerprint,
        usageBaseline: usageBaseline.values,
        usageBaselineSource: usageBaseline.source,
        usageBaselineTurnId: usageBaseline.turnId,
        state: "intent",
        createdAt: now(),
      };
      this.transaction(() => {
        this.putSession({ ...s, state: "starting" });
        this.putOp(operation);
      });
      let issued = false;
      try {
        if (!fresh) {
          const resumed = (
            await this.mutate(
              "thread/resume",
              {
                threadId,
                excludeTurns: true,
                cwd: s.cwd,
                sandbox: s.sandbox,
                approvalPolicy: "never",
                runtimeWorkspaceRoots: [s.cwd],
              },
              beforeMutation,
              () => {},
            )
          )?.thread;
          this.assertIdentity(resumed, s);
          this.assertIdle(resumed);
        }
        const response = await this.mutate(
          "turn/start",
          { threadId, input: [{ type: "text", text }], clientUserMessageId: requestId },
          beforeMutation,
          () => {
            issued = true;
            this.freshThreads.delete(threadId);
            this.pendingStartThread = threadId;
          },
        );
        const turn = response?.turn;
        id(turn?.id);
        this.transaction(() => {
          this.putSession({ ...s, state: "running", activeTurnId: turn.id });
          this.putOp({ ...operation, state: "accepted", turnId: turn.id });
        });
        if (terminal.has(turn.status)) this.handleEvent("turn/completed", { threadId, turn });
        this.replayEvents(threadId, turn.id);
        this.pendingStartThread = null;
        return {
          accepted: true,
          completionVerified: false,
          nativeId: threadId,
          sessionId: threadId,
          executionId: turn.id,
          requestId,
        };
      } catch (error) {
        this.pendingStartThread = null;
        this.transaction(() => {
          this.putSession({ ...s, state: issued ? "unknown" : "idle", reason: error.code ?? "error" });
          this.putOp({ ...operation, state: issued ? "unknown" : "blocked", errorCode: error.code ?? "error" });
        });
        throw error;
      }
    });
  }

  async readOwned(threadId, { refresh = true } = {}) {
    let s = this.owned(threadId);
    if (refresh) {
      const thread = (await this.rpc("thread/read", { threadId, includeTurns: false }))?.thread;
      this.assertIdentity(thread, s);
      if (s.activeTurnId) {
        const page = await this.rpc("thread/turns/list", {
          threadId,
          itemsView: "notLoaded",
          limit: 1,
          sortDirection: "desc",
        });
        const latest = page?.data?.[0];
        if (latest?.id === s.activeTurnId && terminal.has(latest.status))
          this.handleEvent("turn/completed", { threadId, turn: latest });
      }
      s = this.owned(threadId);
      return { ...this.metadata(s), nativeState: status(thread) ?? "unknown", observedAt: now() };
    }
    return this.metadata(s);
  }

  async cancelOwned({ threadId, turnId, requestId = "cancel:" + threadId + ":" + turnId, beforeMutation } = {}) {
    this.assertEnabled();
    id(turnId);
    id(requestId);
    guardCheck(beforeMutation);
    return this.exclusive(async () => {
      const s = this.owned(threadId);
      if (s.activeTurnId !== turnId || !["running", "stopping", "unknown"].includes(s.state))
        fail("MANAGED_TURN_MISMATCH", "只能停止本loop登记的当前执行轮次");
      const fingerprint = hash(["cancel", threadId, turnId]),
        prior = this.op(requestId);
      if (prior && prior.fingerprint !== fingerprint) fail("MANAGED_REQUEST_CONFLICT", "停止请求编号冲突");
      if (prior?.state === "accepted")
        return { accepted: true, completionVerified: false, nativeId: threadId, executionId: turnId };
      if (prior && prior.state !== "blocked") fail("MANAGED_OUTCOME_UNKNOWN", "原停止请求结果未知，先核实执行终态");
      const thread = (await this.rpc("thread/read", { threadId, includeTurns: false }))?.thread;
      this.assertIdentity(thread, s);
      if (status(thread) !== "active") fail("MANAGED_NOT_ACTIVE", "原生会话未运行，先读取结果");
      const page = await this.rpc("thread/turns/list", {
        threadId,
        itemsView: "notLoaded",
        limit: 1,
        sortDirection: "desc",
      });
      if (page?.data?.[0]?.id !== turnId || page.data[0].status !== "inProgress")
        fail("MANAGED_TURN_MISMATCH", "当前原生轮次已变化，未停止其他任务");
      const operation = { requestId, kind: "cancel", threadId, turnId, fingerprint, state: "intent", createdAt: now() };
      this.transaction(() => {
        this.putSession({ ...s, state: "stopping" });
        this.putOp(operation);
      });
      let issued = false;
      try {
        await this.mutate("turn/interrupt", { threadId, turnId }, beforeMutation, () => {
          issued = true;
        });
        this.putOp({ ...operation, state: "accepted" });
        return { accepted: true, completionVerified: false, nativeId: threadId, executionId: turnId };
      } catch (error) {
        this.transaction(() => {
          this.putSession({ ...s, state: issued ? "unknown" : s.state });
          this.putOp({ ...operation, state: issued ? "unknown" : "blocked", errorCode: error.code ?? "error" });
        });
        throw error;
      }
    });
  }

  handleEvent(method, params) {
    if (
      this.closed ||
      !params ||
      !this.db.prepare("SELECT 1 FROM owned_sessions WHERE thread_id=?").get(params.threadId ?? "")
    )
      return;
    const threadId = params.threadId,
      turnId = params.turn?.id ?? params.turnId;
    if (typeof turnId !== "string" || !turnId) return;
    const session = this.owned(threadId);
    if (
      session.activeTurnId !== turnId &&
      session.lastCompletion?.turnId !== turnId &&
      this.pendingStartThread !== threadId
    )
      return;
    const resultKey = JSON.stringify([threadId, turnId]);
    const rememberText = (text) => {
      if (typeof text !== "string" || !text.trim()) return;
      if (Buffer.byteLength(text) > (this.options.maxResultBytes ?? 2 * 1024 * 1024))
        this.results.set(resultKey, { tooLarge: true });
      else this.results.set(resultKey, { text });
    };
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      rememberText(params.item.text);
      this.settle(threadId, turnId);
      return;
    }
    if (method === "turn/completed")
      for (const item of params.turn?.items ?? []) if (item.type === "agentMessage") rememberText(item.text);
    let payload;
    if (method === "turn/completed" && terminal.has(params.turn?.status))
      payload = {
        status: params.turn.status,
        completedAt: params.turn.completedAt ?? null,
        durationMs: params.turn.durationMs ?? null,
      };
    else if (method === "thread/tokenUsage/updated")
      payload = { total: safeUsage(params.tokenUsage?.total), last: safeUsage(params.tokenUsage?.last) };
    else return;
    const encoded = JSON.stringify(payload);
    const latest = this.db
      .prepare("SELECT data FROM owned_events WHERE thread_id=? AND turn_id=? AND kind=? ORDER BY seq DESC LIMIT 1")
      .get(threadId, turnId, method);
    if (latest?.data !== encoded)
      this.db
        .prepare("INSERT INTO owned_events(thread_id,turn_id,kind,data) VALUES(?,?,?,?)")
        .run(threadId, turnId, method, encoded);
    this.applyEvent(threadId, turnId, method, payload);
    queueMicrotask(() => this.settle(threadId, turnId));
  }
  applyEvent(threadId, turnId, kind, data) {
    const s = this.owned(threadId);
    if (s.activeTurnId !== turnId && !(s.state === "idle" && !s.activeTurnId && s.lastCompletion?.turnId === turnId))
      return;
    if (kind === "thread/tokenUsage/updated") this.putSession({ ...s, usage: { turnId, ...data } });
    else if (kind === "turn/completed") {
      this.transaction(() => {
        this.putSession({ ...s, state: "idle", activeTurnId: null, lastCompletion: { turnId, ...data } });
        for (const row of this.db.prepare("SELECT data FROM owned_operations").all()) {
          const op = JSON.parse(row.data);
          if (op.threadId === threadId && op.turnId === turnId && op.state === "accepted")
            this.putOp({ ...op, state: "completed", nativeStatus: data.status });
        }
      });
    }
  }
  replayEvents(threadId, turnId) {
    for (const e of this.db
      .prepare("SELECT kind,data FROM owned_events WHERE thread_id=? AND turn_id=? ORDER BY seq")
      .all(threadId, turnId))
      this.applyEvent(threadId, turnId, e.kind, JSON.parse(e.data));
  }
  events({ after = 0 } = {}) {
    this.assertOpen();
    return this.db
      .prepare("SELECT seq,thread_id,turn_id,kind,data FROM owned_events WHERE seq>? ORDER BY seq LIMIT 100")
      .all(after)
      .map((e) => ({ seq: e.seq, threadId: e.thread_id, turnId: e.turn_id, kind: e.kind, data: JSON.parse(e.data) }));
  }
  completedResult(threadId, turnId) {
    const row = this.db
      .prepare(
        "SELECT data FROM owned_events WHERE thread_id=? AND turn_id=? AND kind='turn/completed' ORDER BY seq DESC LIMIT 1",
      )
      .get(threadId, turnId);
    if (!row) return null;
    const completion = JSON.parse(row.data),
      remembered = this.results.get(JSON.stringify([threadId, turnId]));
    if (remembered?.tooLarge) fail("MANAGED_RESULT_TOO_LARGE", "该轮答案超过传递上限；保留原生结果，不会重跑");
    if (completion.status === "completed" && !remembered?.text) return null;
    const usageRow = this.db
      .prepare(
        "SELECT data FROM owned_events WHERE thread_id=? AND turn_id=? AND kind='thread/tokenUsage/updated' ORDER BY seq DESC LIMIT 1",
      )
      .get(threadId, turnId);
    const nativeUsage = usageRow ? JSON.parse(usageRow.data) : null;
    const total = nativeUsage?.total;
    const operations = this.db
      .prepare(
        "SELECT data FROM owned_operations WHERE json_extract(data,'$.kind')='continue' AND json_extract(data,'$.threadId')=? AND json_extract(data,'$.turnId')=?",
      )
      .all(threadId, turnId);
    const operation = operations.length === 1 ? JSON.parse(operations[0].data) : null;
    const baseline = operation?.usageBaseline;
    const turnUsage = {},
      turnUsageMissing = [],
      turnUsageReasons = {};
    for (const [field, nativeField] of [
      ["input", "inputTokens"],
      ["output", "outputTokens"],
      ["cached", "cachedInputTokens"],
    ]) {
      const start = baseline?.[nativeField],
        end = total?.[nativeField];
      let missing;
      if (!Number.isSafeInteger(start) || start < 0)
        missing = operations.length > 1 ? "baseline-ambiguous" : "baseline-missing";
      else if (!Number.isSafeInteger(end) || end < 0) missing = "current-missing";
      else if (end < start) missing = "counter-regressed";
      if (missing) {
        turnUsageMissing.push(field);
        turnUsageReasons[field] = missing;
      } else turnUsage[field] = end - start;
    }
    const hasTurnUsage = Object.keys(turnUsage).length > 0;
    return {
      nativeId: threadId,
      sessionId: threadId,
      executionId: turnId,
      status: completion.status,
      completionVerified: true,
      text: remembered?.text ?? "",
      nativeUsage,
      turnUsage: hasTurnUsage ? turnUsage : undefined,
      turnUsageStatus: !turnUsageMissing.length ? "complete" : hasTurnUsage ? "partial" : "missing",
      turnUsageMissing,
      turnUsageReasons,
      turnUsageBaselineSource: operation?.usageBaselineSource ?? "missing",
      turnUsageScope: "session-total-delta-from-this-request-intent",
      sessionUsage: total
        ? Object.fromEntries(
            [
              ["input", total.inputTokens],
              ["output", total.outputTokens],
              ["cached", total.cachedInputTokens],
            ].filter(([, value]) => value !== undefined),
          )
        : undefined,
      usageScope: "session-cumulative; do not sum repeated totals",
      completedAt: completion.completedAt,
    };
  }
  settle(threadId, turnId) {
    if (this.closed) return;
    const key = JSON.stringify([threadId, turnId]),
      waiters = this.waiters.get(key);
    if (!waiters?.size) return;
    let result, failure;
    try {
      result = this.completedResult(threadId, turnId);
    } catch (error) {
      failure = error;
    }
    if (!result && !failure) return;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (failure) waiter.reject(failure);
      else waiter.resolve(result);
    }
    this.waiters.delete(key);
  }
  async waitForTurn({ threadId, turnId, timeoutMs = 600_000 } = {}) {
    const session = this.owned(threadId);
    id(turnId);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1_800_000)
      fail("MANAGED_INVALID_INPUT", "等待期限须为正数且不超过30分钟");
    const ownedTurn = this.db
      .prepare("SELECT data FROM owned_operations")
      .all()
      .some((row) => {
        const op = JSON.parse(row.data);
        return (
          op.kind === "continue" &&
          op.threadId === threadId &&
          op.turnId === turnId &&
          ["accepted", "completed"].includes(op.state)
        );
      });
    if (!ownedTurn) fail("MANAGED_TURN_NOT_OWNED", "此轮次没有本loop的受理记录");
    const ready = this.completedResult(threadId, turnId);
    if (ready) return ready;
    if (session.state === "unknown") fail("MANAGED_RESULT_UNKNOWN", "执行结果待核实，不会再次发送");
    const key = JSON.stringify([threadId, turnId]);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.get(key)?.delete(waiter);
        if (!this.waiters.get(key)?.size) this.waiters.delete(key);
        reject(new ManagedCodexError("MANAGED_WAIT_TIMEOUT", "等待期限已到；没有重派，需核实运行状态或明确停止"));
      }, timeoutMs);
      if (!this.waiters.has(key)) this.waiters.set(key, new Set());
      this.waiters.get(key).add(waiter);
    });
  }
  disconnected(code) {
    if (this.closed) return;
    this.freshThreads.clear();
    for (const waiters of this.waiters.values())
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new ManagedCodexError("MANAGED_RESULT_UNKNOWN", "受管连接中断，执行结果待核实", { causeCode: code }),
        );
      }
    this.waiters.clear();
    for (const s of this.sessions())
      if (["creating", "starting", "running", "stopping"].includes(s.state))
        this.putSession({ ...s, state: "unknown", reason: code });
  }
  async close({ force = false } = {}) {
    if (this.closed) return;
    if (this.busy) fail("MANAGED_BUSY", "原生操作仍在进行，不能关闭执行器");
    const active = this.sessions().filter((s) =>
      ["creating", "starting", "running", "stopping", "unknown"].includes(s.state),
    );
    if (active.length && !force) fail("MANAGED_ACTIVE_TURNS", "仍有活动受管任务，先停止并核实终态");
    if (force) this.disconnected("explicit-force-close");
    this.disconnected("executor-closed");
    await this.transport.close();
    this.closed = true;
    this.results.clear();
    this.db.close();
    this.releaseLease();
  }
}
