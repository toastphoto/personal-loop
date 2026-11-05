// Read the existing DSH Host's authoritative Workspace membership; never infer projects from history files.
import { DshConnectorError, DshGatewayClient, bounded, remoteValue } from "./dsh-rpc.mjs";
export { DshConnectorError } from "./dsh-rpc.mjs";
const err = (code, message, blocked = false) => new DshConnectorError(code, message, { blocked });
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value) => {
  if (!nonempty(value)) throw err("DSH_INVALID_ID", "需要明确的原生项目或会话编号");
  return value;
};

export class DshConnector {
  #host;
  #transport;
  #timeout;
  #write;
  #clock;
  #pending = new Set();
  constructor(options = {}) {
    this.#host = options.host ?? "local";
    this.#write = options.writeEnabled === true;
    this.#timeout = options.timeoutMs ?? 5000;
    this.#clock = options.clock ?? (() => new Date());
    if (!nonempty(this.#host) || !Number.isFinite(this.#timeout) || this.#timeout <= 0)
      throw err("DSH_INVALID_CONFIG", "DSH 连接配置无效");
    this.#transport =
      options.transport ??
      options.gateway?.transport ??
      ((options.gatewayUrl ?? options.gateway?.endpoint)
        ? new DshGatewayClient({ ...options, gatewayUrl: options.gatewayUrl ?? options.gateway.endpoint })
        : null);
  }
  #time() {
    return this.#clock().toISOString();
  }
  #wire() {
    if (!this.#transport) throw err("DSH_GATEWAY_NOT_CONFIGURED", "尚未配置现有 DeepSeek Host 的合法连接", true);
    return this.#transport;
  }
  async #safe(action) {
    try {
      return await action();
    } catch (e) {
      if (e instanceof DshConnectorError) throw e;
      throw err("DSH_REMOTE_ERROR", "DeepSeek Host 读取或操作失败", true);
    }
  }
  async #baseline() {
    return this.#safe(() =>
      bounded(async (signal) => {
        const source = this.#wire().stream("workspace/follow", {}, { signal });
        const iterator = source[Symbol.asyncIterator]();
        try {
          const frame = await iterator.next();
          if (frame.done || frame.value?.type !== "baseline" || !Array.isArray(frame.value.value?.items))
            throw err("DSH_INVALID_BASELINE", "DeepSeek 没有返回完整的原生项目快照");
          const items = frame.value.value.items;
          const ids = new Set();
          for (const item of items) {
            if (
              !object(item) ||
              !nonempty(item.workspaceId) ||
              !nonempty(item.path) ||
              !Array.isArray(item.sessionIds) ||
              item.sessionIds.some((x) => !nonempty(x)) ||
              ids.has(item.workspaceId)
            )
              throw err("DSH_INVALID_BASELINE", "DeepSeek 原生项目快照不完整");
            ids.add(item.workspaceId);
          }
          return items;
        } finally {
          await iterator.return?.();
        }
      }, this.#timeout),
    );
  }
  async #sessions() {
    return this.#safe(() =>
      bounded(async (signal) => {
        const result = remoteValue(await this.#wire().call("session/list", { _request: {} }, { signal }));
        if (
          !object(result) ||
          !Array.isArray(result.items) ||
          result.items.some((x) => !object(x) || !nonempty(x.sessionId))
        )
          throw err("DSH_INVALID_RESPONSE", "DeepSeek 会话列表不完整");
        return result.items;
      }, this.#timeout),
    );
  }
  #project(item) {
    return {
      provider: "dsh",
      host: this.#host,
      nativeId: item.workspaceId,
      name: nonempty(item.title) ? item.title : item.workspaceId,
      roots: [item.path],
      capabilities: { read: true, continue: this.#write, cancel: this.#write },
    };
  }
  #work(item, projectNativeId = null) {
    const title = item.projections?.values?.title;
    const cwd = item.projections?.values?.workingDirectory ?? item.cwd;
    const inbox = item.projections?.values?.inbox;
    const pendingInputs = ["next-turn", "next-step"].reduce(
      (n, key) => n + (Array.isArray(inbox?.[key]) ? inbox[key].length : 0),
      0,
    );
    const busy = item.running === true || pendingInputs > 0 ? true : item.running === false ? false : null;
    const validTime =
      typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) && Math.abs(item.updatedAt) <= 8.64e15;
    const child = item.origin === "subagent";
    const state = item.running === true ? "running" : pendingInputs > 0 ? "queued" : busy === null ? "unknown" : "idle";
    const nativeState = item.running === true ? "running" : item.running === false ? "idle" : "unknown";
    const name = nonempty(title) ? title : nonempty(item.title) ? item.title : item.sessionId;
    return {
      provider: "dsh",
      host: this.#host,
      nativeId: item.sessionId,
      projectId: projectNativeId,
      projectNativeId,
      membership: projectNativeId === null ? "unassigned" : "native-project",
      name,
      title: name,
      roots: nonempty(cwd) ? [cwd] : [],
      state,
      nativeState,
      status: state,
      busy,
      pendingInputs,
      agentAvailable: item.agentAvailable === true,
      updatedAt: validTime ? new Date(item.updatedAt).toISOString() : null,
      child,
      formatStatus: item.formatStatus ?? "unknown",
      capabilities: {
        read: true,
        continue: this.#write && busy === false && !child && item.formatStatus !== "migration-required",
        cancel: this.#write && item.running === true && item.agentAvailable === true && !child,
      },
    };
  }
  async listProjects() {
    return {
      projects: (await this.#baseline()).map((item) => this.#project(item)),
      observedAt: this.#time(),
      complete: true,
    };
  }
  async listWork(projectId) {
    identity(projectId);
    const projects = await this.#baseline();
    const project = projects.find((x) => x.workspaceId === projectId);
    if (!project) throw err("DSH_PROJECT_NOT_FOUND", "DeepSeek 原生项目不存在或不可访问");
    const members = new Set(project.sessionIds);
    const rows = await this.#sessions();
    return {
      items: rows.filter((x) => members.has(x.sessionId)).map((x) => this.#work(x, projectId)),
      observedAt: this.#time(),
      complete: project.sessionIds.every((id) => rows.some((x) => x.sessionId === id)),
    };
  }
  async readWork(nativeId) {
    identity(nativeId);
    const projects = await this.#baseline();
    const owners = projects.filter((project) => project.sessionIds.includes(nativeId));
    if (owners.length > 1) throw err("DSH_PROJECT_MISMATCH", "DeepSeek 会话的原生项目归属不一致");
    const item = (await this.#sessions()).find((x) => x.sessionId === nativeId);
    if (!item) throw err("DSH_WORK_NOT_FOUND", "DeepSeek 会话不存在或不可访问");
    return { ...this.#work(item, owners[0]?.workspaceId ?? null), observedAt: this.#time() };
  }
  async #mutation(endpoint, args, beforeMutation) {
    if (beforeMutation !== undefined && typeof beforeMutation !== "function")
      throw err("DSH_INVALID_CALLBACK", "写入前校验必须为同步函数");
    let guardFailed = false;
    let guardError;
    const guard = () => {
      try {
        const result = beforeMutation?.();
        if (result && typeof result.then === "function") throw err("DSH_INVALID_CALLBACK", "写入前校验不能异步执行");
      } catch (error) {
        guardFailed = true;
        guardError = error;
        throw error;
      }
    };
    try {
      return remoteValue(
        await this.#safe(() =>
          bounded((signal) => {
            guard();
            return this.#wire().call(endpoint, args, { signal, beforeMutation: guard });
          }, this.#timeout),
        ),
      );
    } catch (error) {
      // A local pause/revision rejection is certain non-submission, not a remote outcome ambiguity.
      if (guardFailed) throw guardError;
      throw error;
    }
  }
  #writeCheck(nativeId) {
    if (!this.#write) throw err("DSH_WRITE_DISABLED", "DSH 连接器当前仅允许读取");
    identity(nativeId);
    if (this.#pending.has(nativeId)) throw err("DSH_BUSY", "该会话已有连接器操作正在提交");
  }
  async continueWork({ nativeId, text, requestId, beforeMutation } = {}) {
    this.#writeCheck(nativeId);
    if (!nonempty(text) || !nonempty(requestId)) throw err("DSH_INVALID_INPUT", "续办需要正文和稳定请求编号");
    this.#pending.add(nativeId);
    try {
      const current = await this.readWork(nativeId);
      if (!current.capabilities.continue) throw err("DSH_BUSY", "该会话正在运行、状态未知或不能安全续办");
      const result = await this.#mutation(
        "session/prompt",
        { request: { sessionId: nativeId, requestId, mode: "queue", content: [{ type: "text", text }] } },
        beforeMutation,
      );
      if (result?.accepted !== true) throw err("DSH_INVALID_RESPONSE", "DeepSeek 未确认接受续办请求");
      return {
        provider: "dsh",
        host: this.#host,
        nativeId,
        requestId,
        accepted: true,
        completed: false,
        observedAt: this.#time(),
      };
    } finally {
      this.#pending.delete(nativeId);
    }
  }
  async cancelWork(input) {
    const nativeId = typeof input === "string" ? input : input?.nativeId;
    this.#writeCheck(nativeId);
    this.#pending.add(nativeId);
    try {
      const current = await this.readWork(nativeId);
      if (!current.capabilities.cancel) throw err("DSH_NOT_RUNNING", "该会话未确认处于可停止的运行状态");
      const result = await this.#mutation(
        "session/cancel",
        { request: { sessionId: nativeId } },
        typeof input === "object" ? input?.beforeMutation : undefined,
      );
      if (result?.accepted !== true) throw err("DSH_INVALID_RESPONSE", "DeepSeek 未确认接受停止请求");
      return { provider: "dsh", host: this.#host, nativeId, accepted: true, stopped: false, observedAt: this.#time() };
    } finally {
      this.#pending.delete(nativeId);
    }
  }
  async close() {
    await this.#transport?.close?.();
  }
}
