import { spawn } from "node:child_process";

export class ManagedCodexError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ManagedCodexError";
    this.code = code;
    Object.assign(this, extra);
  }
}
const methods = new Set([
  "initialize",
  "project/read",
  "thread/start",
  "thread/read",
  "thread/list",
  "thread/queue/list",
  "thread/queue/add",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
  "turn/start",
  "turn/interrupt",
]);

// Dedicated stdio host for loop-owned threads; never attaches to the user's desktop host.
export class ManagedCodexRpc {
  constructor(options = {}) {
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.closed = false;
  }
  connect() {
    return (this.connecting ??= this.initialize());
  }
  async initialize() {
    if (this.closed) throw new ManagedCodexError("MANAGED_DISCONNECTED", "受管Codex连接已关闭");
    const run = this.options.spawn ?? spawn;
    this.child = run(this.options.command ?? "codex", ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.exit = new Promise((resolve) => this.child.once("exit", resolve));
    this.options.onSpawn?.(this.child.pid);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data) => this.consume(data));
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.fail("MANAGED_DISCONNECTED", "受管Codex连接写入失败"));
    this.child.stdout.on("error", () => this.fail("MANAGED_DISCONNECTED", "受管Codex连接读取失败"));
    this.child.on("error", () => this.fail("MANAGED_DISCONNECTED", "受管Codex进程无法启动"));
    this.child.on("exit", () => this.fail("MANAGED_DISCONNECTED", "受管Codex进程已退出"));
    await this.request("initialize", {
      clientInfo: { name: "personal_loop_owned_executor", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  }
  send(value) {
    if (this.closed) throw new ManagedCodexError("MANAGED_DISCONNECTED", "受管Codex连接已关闭");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  request(method, params) {
    if (!methods.has(method))
      return Promise.reject(new ManagedCodexError("MANAGED_METHOD_DENIED", "受管连接不允许此原生操作"));
    if (this.closed || !this.child)
      return Promise.reject(new ManagedCodexError("MANAGED_DISCONNECTED", "受管Codex连接不可用"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail("MANAGED_TIMEOUT", "受管Codex请求超时，结果必须先核实"),
        this.options.timeoutMs ?? 15_000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch {
        this.fail("MANAGED_DISCONNECTED", "受管Codex连接写入失败");
      }
    });
  }
  consume(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024)
      return this.fail("MANAGED_PROTOCOL_ERROR", "受管Codex响应超过限制");
    while (!this.closed && this.buffer.includes("\n")) {
      const at = this.buffer.indexOf("\n"),
        line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return this.fail("MANAGED_PROTOCOL_ERROR", "受管Codex响应格式无效");
      }
      if (!message || typeof message !== "object" || Array.isArray(message))
        return this.fail("MANAGED_PROTOCOL_ERROR", "受管Codex响应格式无效");
      if (message.method) {
        if (message.id !== undefined)
          this.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Interactive approvals are not supported by this executor" },
          });
        else if (
          ["turn/completed", "thread/tokenUsage/updated"].includes(message.method) ||
          (message.method === "item/completed" && message.params?.item?.type === "agentMessage")
        ) {
          try {
            this.options.onNotification?.(message.method, message.params);
          } catch {
            this.fail("MANAGED_STORAGE_ERROR", "受管执行记录无法保存");
          }
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new ManagedCodexError("MANAGED_RPC_ERROR", "受管Codex拒绝了请求", { rpcCode: message.error.code }),
        );
      else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new ManagedCodexError("MANAGED_PROTOCOL_ERROR", "受管Codex响应缺少结果"));
    }
  }
  fail(code, message) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ManagedCodexError(code, message));
    }
    this.pending.clear();
    this.buffer = "";
    if (!this.closing) {
      try {
        this.options.onDisconnect?.(code);
      } catch {}
    }
    this.child?.kill("SIGTERM");
  }
  async close() {
    this.closing = true;
    this.fail("MANAGED_DISCONNECTED", "受管连接已关闭");
    if (!this.child) return;
    let timer;
    await Promise.race([
      this.exit,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          this.child.kill("SIGKILL");
          resolve();
        }, 1000);
      }),
    ]);
    clearTimeout(timer);
  }
}
