// DSH 0.2.1-rc.3 native Host wire protocol. Authorization is supplied explicitly by the caller.
import { randomUUID } from "node:crypto";

export class DshConnectorError extends Error {
  constructor(code, message, { blocked = false } = {}) {
    super(message);
    this.name = "DshConnectorError";
    this.code = code;
    this.blocked = blocked;
  }
}
const error = (code, message, blocked = false) => new DshConnectorError(code, message, { blocked });
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export function remoteValue(result) {
  if (!record(result) || typeof result.ok !== "boolean") return result;
  if (!result.ok) throw error("DSH_REMOTE_ERROR", "DeepSeek Host 拒绝了本次请求", true);
  return result.value;
}
export async function bounded(operation, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const signal = outerSignal ? AbortSignal.any([controller.signal, outerSignal]) : controller.signal;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(error("DSH_TIMEOUT", "DeepSeek 连接超时，未自动重试"));
        }, timeoutMs);
      }),
      new Promise((_, reject) => {
        if (outerSignal?.aborted) reject(error("DSH_CANCELLED", "DeepSeek 请求已取消"));
        else
          outerSignal?.addEventListener("abort", () => reject(error("DSH_CANCELLED", "DeepSeek 请求已取消")), {
            once: true,
            signal: controller.signal,
          });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export class DshGatewayClient {
  #base;
  #launchTokenEnv;
  #env;
  #timeout;
  #socket;
  #cookie;
  #connecting;
  #streams = new Map();
  constructor({ gatewayUrl, launchTokenEnv, authorizationEnv, env = process.env, timeoutMs = 5000 } = {}) {
    let base;
    try {
      base = new URL(gatewayUrl);
    } catch {
      throw error("DSH_GATEWAY_NOT_CONFIGURED", "请配置现有 DeepSeek Host 的地址", true);
    }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      (!loopback && base.protocol !== "https:") ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/"
    ) {
      throw error("DSH_UNSAFE_GATEWAY", "DeepSeek Host 地址须为无凭据的本机 HTTP 或 HTTPS 根地址", true);
    }
    this.#base = base;
    this.#launchTokenEnv = launchTokenEnv ?? authorizationEnv;
    this.#env = env;
    this.#timeout = timeoutMs;
    if (this.#launchTokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.#launchTokenEnv))
      throw error("DSH_INVALID_CONFIG", "授权环境变量名无效");
  }
  async connect() {
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = bounded((signal) => this.#open(signal), this.#timeout).finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }
  async #open(signal) {
    const token = this.#launchTokenEnv ? this.#env[this.#launchTokenEnv] : undefined;
    if (typeof token !== "string" || !token.trim())
      throw error(
        "DSH_AUTHORIZATION_REQUIRED",
        "需要通过 DeepSeek 正常连接入口授权，并将 launch token 提供到指定环境变量",
        true,
      );
    const url = new URL("/connect", this.#base);
    url.searchParams.set("token", token);
    url.searchParams.set("interactions", "none");
    let response;
    try {
      response = await fetch(url, { redirect: "manual", signal });
    } catch {
      throw error("DSH_CONNECTION_FAILED", "无法连接现有 DeepSeek Host", true);
    }
    if ([401, 403].includes(response.status))
      throw error("DSH_AUTHORIZATION_REQUIRED", "DeepSeek Host 未接受授权，请从正常连接入口重新授权", true);
    const location = response.headers.get("location");
    if (
      response.status !== 302 ||
      !location ||
      new URL(location, url).href !== new URL("/api/remote.mux", this.#base).href
    ) {
      throw error("DSH_INVALID_HANDSHAKE", "DeepSeek Host 返回了不支持的授权握手", true);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length !== 1 || !/^[^=;\s]+=[^;\r\n]+/.test(cookies[0]))
      throw error("DSH_INVALID_HANDSHAKE", "DeepSeek Host 没有返回独立 API 授权", true);
    this.#cookie = cookies[0].split(";", 1)[0];
    const wsUrl = new URL("/api/remote.mux", this.#base);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    // Node 24 WebSocketInit supports headers; this cookie was minted for this client by /connect.
    const socket = new WebSocket(wsUrl, { headers: { Cookie: this.#cookie } });
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#message(event));
    socket.addEventListener("close", () => this.#disconnected(socket));
    socket.addEventListener("error", () => this.#disconnected(socket));
    await new Promise((resolve, reject) => {
      const stop = () => {
        try {
          socket.close();
        } catch {}
        reject(error("DSH_CANCELLED", "DeepSeek 连接已取消"));
      };
      const cleanup = () => {
        signal.removeEventListener("abort", stop);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(error("DSH_CONNECTION_FAILED", "DeepSeek 原生流连接失败", true));
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
      signal.addEventListener("abort", stop, { once: true });
    });
  }
  #disconnected(socket) {
    if (this.#socket !== socket) return;
    this.#cookie = undefined;
    for (const stream of this.#streams.values()) {
      stream.error = error("DSH_CONNECTION_FAILED", "DeepSeek 原生连接已断开", true);
      stream.wake?.();
    }
  }
  #message(event) {
    let frame;
    try {
      if (typeof event.data !== "string" || event.data.length > 2_000_000) throw new Error();
      frame = JSON.parse(event.data);
      if (!record(frame) || typeof frame.streamId !== "string" || !["item", "end", "error"].includes(frame.type))
        throw new Error();
    } catch {
      for (const stream of this.#streams.values()) {
        stream.error = error("DSH_INVALID_RESPONSE", "DeepSeek 返回了无效流数据");
        stream.wake?.();
      }
      return;
    }
    const stream = this.#streams.get(frame.streamId);
    if (!stream) return;
    if (frame.type === "item") {
      if (stream.items.length >= 1000) stream.error = error("DSH_STREAM_OVERFLOW", "DeepSeek 流数据超出本次读取上限");
      else stream.items.push(frame.value);
    } else if (frame.type === "end") stream.done = true;
    else stream.error = error("DSH_REMOTE_ERROR", "DeepSeek Host 拒绝了本次订阅", true);
    stream.wake?.();
  }
  async call(endpoint, args = {}, { signal, beforeMutation } = {}) {
    this.#validateEndpoint(endpoint);
    await this.connect();
    return bounded(
      async (combined) => {
        const rpcId = randomUUID();
        let response;
        // Recheck after an asynchronous authorization/connect handshake, immediately before network mutation.
        beforeMutation?.();
        try {
          response = await fetch(new URL("/api/" + endpoint, this.#base), {
            method: "POST",
            redirect: "manual",
            signal: combined,
            headers: { "content-type": "application/json", Cookie: this.#cookie },
            body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
          });
        } catch {
          throw error("DSH_CONNECTION_FAILED", "DeepSeek 请求未完成；未自动重试", true);
        }
        if ([401, 403].includes(response.status))
          throw error("DSH_AUTHORIZATION_REQUIRED", "DeepSeek Host 拒绝了访问", true);
        if (!response.ok) throw error("DSH_CONNECTION_FAILED", "DeepSeek Host 请求失败；未自动重试", true);
        let body;
        try {
          body = JSON.parse(await response.text());
        } catch {
          throw error("DSH_INVALID_RESPONSE", "DeepSeek 返回了无效 JSON");
        }
        if (!record(body) || body.rpcId !== rpcId || !record(body.result) || typeof body.result.ok !== "boolean")
          throw error("DSH_INVALID_RESPONSE", "DeepSeek 回复与请求不匹配");
        return remoteValue(body.result);
      },
      this.#timeout,
      signal,
    );
  }
  async *stream(endpoint, args = {}, { signal } = {}) {
    this.#validateEndpoint(endpoint);
    await this.connect();
    const streamId = randomUUID();
    const state = { items: [], done: false, error: undefined, wake: undefined };
    this.#streams.set(streamId, state);
    const abort = () => {
      state.error = error("DSH_CANCELLED", "DeepSeek 订阅已取消");
      state.wake?.();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      if (state.error) throw state.error;
      this.#socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
      while (true) {
        if (state.error) throw state.error;
        if (state.items.length) {
          yield state.items.shift();
          continue;
        }
        if (state.done) return;
        await new Promise((resolve) => {
          state.wake = resolve;
        });
        state.wake = undefined;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#streams.delete(streamId);
      if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify({ type: "cancel", streamId }));
    }
  }
  #validateEndpoint(endpoint) {
    if (
      typeof endpoint !== "string" ||
      !/^[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/.test(endpoint) ||
      endpoint.split("/").some((x) => x === "." || x === "..")
    )
      throw error("DSH_INVALID_ENDPOINT", "DeepSeek 接口名无效");
  }
  async close() {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#cookie = undefined;
    for (const stream of this.#streams.values()) {
      stream.error = error("DSH_CANCELLED", "DeepSeek 连接已关闭");
      stream.wake?.();
    }
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }
}
