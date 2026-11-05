import { spawn as nodeSpawn } from "node:child_process";

export class CodexConnectorError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "CodexConnectorError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const error = (code, message, extra) => new CodexConnectorError(code, message, extra);
const CATALOG_METHODS = new Set(["initialize", "project/list", "thread/list"]);

// Own only this transport process; never start/restart a managed daemon or reach into its database.
export class CodexRpcProxy {
  constructor(options = {}) {
    this.options = options;
    this.mode = options.mode ?? "control-proxy";
    if (!["control-proxy", "isolated-readonly-api"].includes(this.mode))
      throw error("CODEX_CONFIG_ERROR", "未知的Codex连接模式");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
      throw error("CODEX_CONFIG_ERROR", "Codex超时必须为正数");
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.closed = false;
    const args = options.commandArgs ?? [];
    if (
      !Array.isArray(args) ||
      args.length % 2 !== 0 ||
      args.some(
        (part, i) =>
          typeof part !== "string" ||
          /[\u0000\r\n]/.test(part) ||
          (i % 2 === 0 && !["-c", "--config", "--enable", "--disable"].includes(part)),
      )
    ) {
      throw error("CODEX_CONFIG_ERROR", "额外参数只允许配置或功能选项，不能改变连接方式或启动daemon");
    }
  }

  connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize();
    return this.connecting;
  }

  async initialize() {
    if (this.closed) throw error("CODEX_DISCONNECTED", "Codex连接已关闭");
    const { command = "codex", socket, commandArgs = [], spawn = nodeSpawn } = this.options;
    if (socket && this.mode !== "control-proxy") throw error("CODEX_CONFIG_ERROR", "只读独立API不使用控制连接");
    const args =
      this.mode === "control-proxy"
        ? ["app-server", "proxy", ...(socket ? ["--sock", socket] : []), ...commandArgs]
        : ["app-server", "--stdio", ...commandArgs];
    try {
      this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch {
      this.closed = true;
      throw error("CODEX_NOT_CONNECTED", "无法打开Codex连接，请确认已配置受支持的连接方式");
    }
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data) => this.consume(data));
    this.child.stderr.on("data", () => {});
    this.child.stdout.on("error", () => this.fail(error("CODEX_DISCONNECTED", "Codex连接读取失败")));
    this.child.stdin.on("error", () => this.fail(error("CODEX_DISCONNECTED", "Codex连接写入失败")));
    this.child.on("error", () =>
      this.fail(error("CODEX_NOT_CONNECTED", "无法打开Codex连接，请确认程序与控制连接存在")),
    );
    this.child.on("exit", (exitCode, signal) =>
      this.fail(error("CODEX_DISCONNECTED", "Codex连接已退出；未启动或重启任何常驻服务", { exitCode, signal })),
    );
    await this.request("initialize", {
      clientInfo: { name: "personal_loop_native_projects", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ jsonrpc: "2.0", method: "initialized", params: {} });
  }

  request(method, params = {}) {
    if (this.mode === "isolated-readonly-api" && !CATALOG_METHODS.has(method)) {
      return Promise.reject(error("CODEX_CONTROL_UNAVAILABLE", "独立只读API仅允许列出项目与会话，不能控制桌面任务"));
    }
    if (this.closed || !this.child) return Promise.reject(error("CODEX_DISCONNECTED", "Codex连接不可用"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(error("CODEX_TIMEOUT", "Codex请求超时；执行结果未知时不可直接重试写操作", { method })),
        this.timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch {
        this.fail(error("CODEX_DISCONNECTED", "Codex连接写入失败"));
      }
    });
  }

  write(message) {
    if (this.closed || !this.child) throw error("CODEX_DISCONNECTED", "Codex连接已关闭");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  consume(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024)
      return this.fail(error("CODEX_PROTOCOL_ERROR", "Codex响应超过限制"));
    while (!this.closed && this.buffer.includes("\n")) {
      const at = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return this.fail(error("CODEX_PROTOCOL_ERROR", "Codex返回了无法识别的协议数据"));
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame))
        return this.fail(error("CODEX_PROTOCOL_ERROR", "Codex返回了无效的协议消息"));
      if (typeof frame.method === "string") {
        // Never implicitly approve requests emitted by a running thread.
        if (frame.id !== undefined)
          this.write({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32601, message: "This connector cannot provide interactive approvals" },
          });
        else if (["project/changed", "thread/status/changed", "turn/completed"].includes(frame.method))
          this.options.onNotification?.(frame.method, frame.params);
        continue;
      }
      const pending = this.pending.get(frame.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error) pending.reject(error("CODEX_RPC_ERROR", "Codex接口拒绝了请求", { rpcCode: frame.error.code }));
      else if (Object.hasOwn(frame, "result")) pending.resolve(frame.result);
      else pending.reject(error("CODEX_PROTOCOL_ERROR", "Codex响应缺少结果"));
    }
  }

  fail(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
    this.buffer = "";
    this.child?.kill("SIGTERM");
  }

  async close() {
    this.fail(error("CODEX_DISCONNECTED", "Codex连接已关闭"));
  }
}
