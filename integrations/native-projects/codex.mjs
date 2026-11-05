import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { CodexRpcProxy, CodexConnectorError } from "./codex-rpc.mjs";

const fail = (code, message) => {
  throw new CodexConnectorError(code, message);
};
const now = () => new Date().toISOString();
const validId = (value) => typeof value === "string" && value.trim() && value.length <= 256;
const requireId = (value) => {
  if (!validId(value)) fail("CODEX_INVALID_INPUT", "需要有效的原生项目或任务编号");
};
const nativeStatus = (thread) =>
  typeof thread.status === "string" ? thread.status : (thread.status?.type ?? "unknown");
const stateOf = (thread) => {
  const status = nativeStatus(thread);
  if (status === "active") return thread.status?.activeFlags?.length ? "waiting" : "running";
  if (status === "idle") return "idle";
  if (status === "systemError") return "error";
  return "unknown";
};
const epoch = (value) =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;

export class CodexConnector {
  constructor(options = {}) {
    this.options = options;
    this.host = options.host ?? "local";
    this.mode = options.mode ?? "control-proxy";
    if (!["control-proxy", "isolated-readonly-api"].includes(this.mode))
      fail("CODEX_CONFIG_ERROR", "未知的Codex连接模式");
    this.writeEnabled = options.writeEnabled === true && this.mode === "control-proxy";
    this.transport = options.transportFactory?.() ?? new CodexRpcProxy(options);
    this.requests = new Map();
    this.busy = new Set();
    this.projectRoots = new Map();
  }

  async rpc(method, params, beforeMutation) {
    await this.transport.connect();
    if (beforeMutation !== undefined) {
      if (typeof beforeMutation !== "function") fail("CODEX_INVALID_INPUT", "写入前检查必须是同步回调");
      // No await may separate the final control-state check from transport submission.
      const checked = beforeMutation();
      if (checked && typeof checked.then === "function") {
        checked.catch?.(() => {});
        fail("CODEX_INVALID_INPUT", "写入前检查必须同步完成");
      }
    }
    return this.transport.request(method, params);
  }

  async pages(method, params) {
    const items = [],
      cursors = new Set();
    let cursor;
    for (let page = 0; page < 1000; page++) {
      const response = await this.rpc(method, { ...params, ...(cursor ? { cursor } : {}) });
      if (!response || !Array.isArray(response.data)) fail("CODEX_PROTOCOL_ERROR", "Codex分页响应缺少原生数据");
      items.push(...response.data);
      const next = response.nextCursor;
      if (next === null || next === undefined || next === "") return items;
      if (typeof next !== "string") fail("CODEX_PROTOCOL_ERROR", "Codex分页游标无效");
      if (cursors.has(next)) fail("CODEX_PAGINATION_LOOP", "Codex分页游标重复，项目目录尚未完整读取");
      cursors.add(next);
      cursor = next;
    }
    fail("CODEX_PAGINATION_LIMIT", "Codex目录超过本轮分页上限");
  }

  async listProjects() {
    const rows = await this.pages("project/list", { limit: 100 });
    const seen = new Set();
    const projects = rows.map((row) => {
      if (!row || !validId(row.id) || typeof row.name !== "string" || !Array.isArray(row.roots))
        fail("CODEX_PROTOCOL_ERROR", "Codex项目元数据无效");
      if (seen.has(row.id)) fail("CODEX_DUPLICATE_ID", "Codex项目分页出现重复编号，请重新读取");
      seen.add(row.id);
      const roots = row.roots.map((root) => root.path);
      if (roots.some((path) => typeof path !== "string" || !(posix.isAbsolute(path) || win32.isAbsolute(path))))
        fail("CODEX_PROTOCOL_ERROR", "Codex项目目录无效");
      this.projectRoots.set(row.id, roots);
      return {
        provider: "codex",
        host: this.host,
        nativeId: row.id,
        name: row.name,
        roots,
        capabilities: { read: true, continue: this.writeEnabled, cancel: this.writeEnabled },
      };
    });
    return {
      projects,
      observedAt: now(),
      complete: true,
      connectionMode: this.mode,
      controlAvailable: this.mode === "control-proxy",
    };
  }

  metadata(thread, fallbackProjectId, membership = "native-project") {
    if (!thread || !validId(thread.id)) fail("CODEX_PROTOCOL_ERROR", "Codex会话元数据缺少编号");
    return {
      provider: "codex",
      host: this.host,
      nativeId: thread.id,
      projectId: thread.projectId ?? fallbackProjectId ?? null,
      nativeProjectId: thread.projectId ?? null,
      membership,
      title: typeof thread.name === "string" ? thread.name : "",
      state: stateOf(thread),
      nativeState: nativeStatus(thread),
      updatedAt: epoch(thread.updatedAt),
      canContinue:
        this.writeEnabled &&
        ["idle", "notLoaded"].includes(nativeStatus(thread)) &&
        thread.canAcceptDirectInput !== false,
      canCancel: this.writeEnabled && nativeStatus(thread) === "active",
    };
  }

  async listWork(projectId) {
    requireId(projectId);
    const rows = await this.pages("thread/list", { projectId, useStateDbOnly: true, limit: 100 });
    const seen = new Set();
    const items = rows.map((row) => {
      const item = this.metadata(row, projectId);
      if (row.projectId !== projectId) fail("CODEX_PROJECT_MISMATCH", "Codex返回了其他项目的会话");
      if (seen.has(item.nativeId)) fail("CODEX_DUPLICATE_ID", "Codex会话分页出现重复编号");
      seen.add(item.nativeId);
      return item;
    });
    if (this.options.includeUnassignedByRoot === true) {
      if (!this.projectRoots.has(projectId)) await this.listProjects();
      const roots = this.projectRoots.get(projectId);
      if (!roots) fail("CODEX_PROJECT_NOT_FOUND", "原生项目目录不存在，不能推断旧会话归属");
      if (roots.length) {
        const legacy = await this.pages("thread/list", {
          projectId: null,
          cwd: roots,
          useStateDbOnly: true,
          limit: 100,
        });
        for (const row of legacy) {
          if (row.projectId !== null || !roots.includes(row.cwd))
            fail("CODEX_PROJECT_MISMATCH", "目录关联查询返回了不属于该范围的会话");
          const item = this.metadata(row, projectId, "cwd-unassigned");
          if (!seen.has(item.nativeId)) {
            seen.add(item.nativeId);
            items.push(item);
          }
        }
      }
    }
    return {
      items,
      observedAt: now(),
      complete: true,
      connectionMode: this.mode,
      controlAvailable: this.mode === "control-proxy",
    };
  }

  async rawWork(id) {
    requireId(id);
    if (this.mode !== "control-proxy")
      fail("CODEX_CONTROL_UNAVAILABLE", "独立只读API仅提供项目和会话目录，未连接当前桌面运行状态");
    const result = await this.rpc("thread/read", { threadId: id, includeTurns: false });
    if (result?.thread?.id !== id) fail("CODEX_WORK_MISMATCH", "Codex返回的会话与请求不符");
    return result.thread;
  }

  async readWork(id) {
    return this.metadata(await this.rawWork(id));
  }

  assertWrite() {
    if (!this.writeEnabled) fail("CODEX_WRITE_DISABLED", "此Codex连接器仅可读取；原生任务写操作未启用");
  }

  assertIdle(thread) {
    if (!["idle", "notLoaded"].includes(nativeStatus(thread)) || thread.canAcceptDirectInput === false)
      fail("CODEX_WORK_NOT_IDLE", "原Codex会话正在运行、等待决定或不可接受输入，未派发新任务");
  }

  continueWork({ nativeId, text, requestId, beforeMutation } = {}) {
    try {
      this.assertWrite();
      requireId(nativeId);
      requireId(requestId);
      if (typeof text !== "string" || !text.trim() || text.length > 100_000)
        fail("CODEX_INVALID_INPUT", "任务内容为空或超过限制");
    } catch (e) {
      return Promise.reject(e);
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([nativeId, text]))
      .digest("hex");
    const previous = this.requests.get(requestId);
    if (previous)
      return previous.fingerprint === fingerprint
        ? previous.result
        : Promise.reject(new CodexConnectorError("CODEX_REQUEST_CONFLICT", "同一请求编号不能用于不同任务内容"));
    if (this.requests.size >= 1000)
      return Promise.reject(
        new CodexConnectorError("CODEX_LEDGER_LIMIT", "本连接器请求记录已满；请先核对持久任务记录"),
      );
    const result = this.withWorkLock(nativeId, async () => {
      this.assertIdle(await this.rawWork(nativeId));
      const resumed = await this.rpc("thread/resume", { threadId: nativeId, excludeTurns: true }, beforeMutation);
      if (resumed?.thread?.id !== nativeId) fail("CODEX_WORK_MISMATCH", "原会话未恢复，不会创建替代会话");
      this.assertIdle(resumed.thread);
      // Preserve native settings; the supervisor must hold task ownership across this preflight and write.
      const response = await this.rpc(
        "turn/start",
        { threadId: nativeId, input: [{ type: "text", text }], clientUserMessageId: requestId },
        beforeMutation,
      );
      if (!validId(response?.turn?.id)) fail("CODEX_PROTOCOL_ERROR", "Codex未返回执行编号；先核实，不能重复派发");
      return {
        accepted: true,
        completed: false,
        completionVerified: false,
        nativeId,
        sessionId: nativeId,
        executionId: response.turn.id,
        requestId,
        concurrencyGuard: "preflight-only",
        idempotencyScope: "connector-instance; durable ledger required",
      };
    });
    // Keep ambiguous failures too: retrying the same request must not repeat an accepted remote side effect.
    this.requests.set(requestId, { fingerprint, result });
    return result;
  }

  async cancelWork({ nativeId, turnId, beforeMutation } = {}) {
    this.assertWrite();
    requireId(nativeId);
    requireId(turnId);
    return this.withWorkLock(nativeId, async () => {
      if (nativeStatus(await this.rawWork(nativeId)) !== "active")
        fail("CODEX_WORK_NOT_ACTIVE", "原Codex会话当前未运行，未发送停止请求");
      const result = await this.rpc("thread/turns/list", {
        threadId: nativeId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "none",
      });
      const active = result?.data?.[0];
      if (active?.id !== turnId || active.status !== "inProgress")
        fail("CODEX_TURN_MISMATCH", "当前执行轮次已变化，未停止其他任务");
      await this.rpc("turn/interrupt", { threadId: nativeId, turnId }, beforeMutation);
      return {
        accepted: true,
        completed: false,
        completionVerified: false,
        nativeId,
        executionId: turnId,
        verificationRequired: true,
      };
    });
  }

  async withWorkLock(id, operation) {
    if (this.busy.has(id)) fail("CODEX_WORK_BUSY", "本连接器已有同会话操作在进行");
    this.busy.add(id);
    try {
      return await operation();
    } finally {
      this.busy.delete(id);
    }
  }

  async close() {
    await this.transport.close();
  }
}
