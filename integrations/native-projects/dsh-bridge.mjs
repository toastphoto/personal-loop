import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";

const READ_METHODS = new Set(["workspace/list", "session/list", "session/read", "session/status", "session/reply"]);
const REMOTE_ERRORS = new Set([
  "INVALID_JSON",
  "INVALID_REQUEST",
  "METHOD_NOT_ALLOWED",
  "REQUEST_LIMIT",
  "READ_TIMEOUT",
  "READ_CANCELLED",
  "WORKSPACE_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "INVALID_NATIVE_METADATA",
  "READ_FAILED",
  "CLIENT_LIMIT",
  "MESSAGE_TOO_LARGE",
  "RESPONSE_TOO_LARGE",
  "REPLY_PREVIEW_DISABLED",
  "REPLY_PREVIEW_UNSUPPORTED",
  "SESSION_WORKSPACE_MISMATCH",
  "INVALID_NATIVE_REPLY",
]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value) =>
  typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 256 && !value.includes("\0");
const fail = (code) => Object.assign(new Error(code), { code });
const writeCapabilities = () => ({ read: true, continue: false, cancel: false });
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const time = (value) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15
    ? new Date(value).toISOString()
    : null;

function safeError(error) {
  if (/^DSH_(?:BRIDGE_[A-Z_]+|WRITE_DISABLED)$/.test(error?.code ?? "")) return error;
  if (error?.code === "ENOENT") return fail("DSH_BRIDGE_NOT_AVAILABLE");
  if (["EACCES", "EPERM"].includes(error?.code)) return fail("DSH_BRIDGE_PERMISSION_REQUIRED");
  if (error?.code === "ECONNREFUSED") return fail("DSH_BRIDGE_NOT_LISTENING");
  if (["ECONNRESET", "EPIPE"].includes(error?.code)) return fail("DSH_BRIDGE_DISCONNECTED");
  return fail("DSH_BRIDGE_READ_FAILED");
}

function envelope(result) {
  if (
    !object(result) ||
    typeof result.complete !== "boolean" ||
    typeof result.observedAt !== "string" ||
    !Number.isFinite(Date.parse(result.observedAt)) ||
    !validId(result.bridgeInstance) ||
    !integer(result.hostProcessId, 1, Number.MAX_SAFE_INTEGER)
  )
    throw fail("DSH_BRIDGE_INVALID_RESPONSE");
  return result;
}
function sameHost(first, second) {
  if (first.bridgeInstance !== second.bridgeInstance || first.hostProcessId !== second.hostProcessId)
    throw fail("DSH_BRIDGE_HOST_CHANGED");
}

// This is a client of the reviewed, same-user metadata plugin, not arbitrary DSH Remote RPC.
export class DshBridgeConnector {
  #socketPath;
  #host;
  #timeout;
  #maxResponse;
  #pending = new Set();
  #closed = false;
  #allowConversationPreview;
  constructor({
    bridgeSocket,
    host = "local",
    timeoutMs = 5000,
    maxResponseBytes = 2097152,
    allowConversationPreview = false,
  } = {}) {
    this.#allowConversationPreview = allowConversationPreview === true;
    if (
      typeof process.getuid !== "function" ||
      !validId(host) ||
      !integer(timeoutMs, 1, 60000) ||
      !integer(maxResponseBytes, 1024, 16777216)
    )
      throw fail("DSH_BRIDGE_INVALID_CONFIG");
    if (
      bridgeSocket !== undefined &&
      (typeof bridgeSocket !== "string" ||
        !path.isAbsolute(bridgeSocket) ||
        bridgeSocket.includes("\0") ||
        Buffer.byteLength(bridgeSocket) > 100)
    )
      throw fail("DSH_BRIDGE_INVALID_CONFIG");
    this.#socketPath = bridgeSocket ? path.resolve(bridgeSocket) : null;
    this.#host = host;
    this.#timeout = timeoutMs;
    this.#maxResponse = maxResponseBytes;
  }
  async #identity() {
    if (!this.#socketPath) throw fail("DSH_BRIDGE_NOT_CONFIGURED");
    const uid = process.getuid();
    const parent = await lstat(path.dirname(this.#socketPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700)
      throw fail("DSH_BRIDGE_PRIVATE_DIRECTORY_REQUIRED");
    const socket = await lstat(this.#socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600)
      throw fail("DSH_BRIDGE_PRIVATE_SOCKET_REQUIRED");
    return { parentDevice: parent.dev, parentInode: parent.ino, device: socket.dev, inode: socket.ino };
  }
  async #request(method, params = {}) {
    if (this.#closed) throw fail("DSH_BRIDGE_CLOSED");
    if (!READ_METHODS.has(method)) throw fail("DSH_BRIDGE_METHOD_NOT_ALLOWED");
    const fields =
      method === "workspace/list"
        ? []
        : method === "session/list"
          ? ["workspaceId"]
          : method === "session/reply"
            ? ["workspaceId", "sessionId"]
            : ["sessionId"];
    if (
      !object(params) ||
      Object.keys(params).some((key) => !fields.includes(key)) ||
      Object.values(params).some((value) => !validId(value)) ||
      (["session/read", "session/status", "session/reply"].includes(method) && !validId(params.sessionId))
    )
      throw fail("DSH_BRIDGE_INVALID_INPUT");
    const id = randomUUID();
    const message = Buffer.from(JSON.stringify({ id, method, params }) + "\n");
    if (message.length > 16384) throw fail("DSH_BRIDGE_REQUEST_TOO_LARGE");
    return new Promise((resolve, reject) => {
      let socket,
        done = false,
        buffer = Buffer.alloc(0);
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#pending.delete(cancel);
        socket?.destroy();
        if (error) reject(safeError(error));
        else resolve(result);
      };
      const cancel = () => finish(fail("DSH_BRIDGE_CLOSED"));
      const timer = setTimeout(() => finish(fail("DSH_BRIDGE_TIMEOUT")), this.#timeout);
      this.#pending.add(cancel);
      void (async () => {
        const before = await this.#identity();
        if (done) return;
        socket = net.createConnection({ path: this.#socketPath });
        socket.on("error", (error) => finish(error));
        socket.on("end", () => finish(fail("DSH_BRIDGE_DISCONNECTED")));
        socket.on("close", () => finish(fail("DSH_BRIDGE_DISCONNECTED")));
        socket.once("connect", () => {
          void (async () => {
            const after = await this.#identity();
            if (Object.keys(before).some((key) => before[key] !== after[key])) throw fail("DSH_BRIDGE_SOCKET_CHANGED");
            if (!done) socket.write(message);
          })().catch((error) => finish(error));
        });
        socket.on("data", (chunk) => {
          if (done) return;
          buffer = Buffer.concat([buffer, chunk]);
          const newline = buffer.indexOf(10);
          if ((newline < 0 && buffer.length > this.#maxResponse) || newline > this.#maxResponse) {
            finish(fail("DSH_BRIDGE_RESPONSE_TOO_LARGE"));
            return;
          }
          if (newline < 0) return;
          let reply;
          try {
            reply = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
          } catch {
            finish(fail("DSH_BRIDGE_INVALID_RESPONSE"));
            return;
          }
          if (!object(reply) || typeof reply.ok !== "boolean") {
            finish(fail("DSH_BRIDGE_INVALID_RESPONSE"));
            return;
          }
          if (reply.id !== id && !(reply.id === null && reply.ok === false)) {
            finish(fail("DSH_BRIDGE_RESPONSE_ID_MISMATCH"));
            return;
          }
          if (!reply.ok) {
            const code = REMOTE_ERRORS.has(reply.error?.code) ? reply.error.code : "REMOTE_ERROR";
            finish(fail(`DSH_BRIDGE_${code}`));
            return;
          }
          try {
            finish(null, envelope(reply.result));
          } catch (error) {
            finish(error);
          }
        });
      })().catch((error) => finish(error));
    });
  }
  async #projects() {
    const result = await this.#request("workspace/list");
    if (!Array.isArray(result.items)) throw fail("DSH_BRIDGE_INVALID_METADATA");
    const ids = new Set(),
      membership = new Map();
    const projects = result.items.map((item) => {
      if (
        !object(item) ||
        !validId(item.workspaceId) ||
        ids.has(item.workspaceId) ||
        typeof item.title !== "string" ||
        typeof item.path !== "string" ||
        !path.isAbsolute(item.path) ||
        item.path.includes("\0") ||
        !Array.isArray(item.sessionIds)
      )
        throw fail("DSH_BRIDGE_INVALID_METADATA");
      ids.add(item.workspaceId);
      for (const sessionId of item.sessionIds) {
        if (!validId(sessionId) || membership.has(sessionId)) throw fail("DSH_BRIDGE_INVALID_METADATA");
        membership.set(sessionId, item.workspaceId);
      }
      return {
        provider: "dsh",
        host: this.#host,
        nativeId: item.workspaceId,
        name: item.title.trim() || item.workspaceId,
        roots: [item.path],
        capabilities: writeCapabilities(),
        sessionIds: [...item.sessionIds],
      };
    });
    return { result, projects, membership };
  }
  #work(item, owner) {
    if (!object(item) || !validId(item.sessionId) || item.projectId !== owner || !validId(owner))
      throw fail("DSH_BRIDGE_PROJECT_MISMATCH");
    if (
      !["running", "idle", "queued", "unknown"].includes(item.state) ||
      !["running", "idle", "not_loaded", "unknown"].includes(item.nativeState) ||
      ![true, false, null].includes(item.running) ||
      typeof item.agentAvailable !== "boolean" ||
      !["root", "subagent"].includes(item.origin)
    )
      throw fail("DSH_BRIDGE_INVALID_METADATA");
    if (
      (item.nativeState === "not_loaded" && (item.state !== "unknown" || item.running !== null)) ||
      (item.state === "running" && item.running !== true)
    )
      throw fail("DSH_BRIDGE_INVALID_METADATA");
    const title = typeof item.title === "string" && item.title.trim() ? item.title : item.sessionId;
    return {
      provider: "dsh",
      host: this.#host,
      nativeId: item.sessionId,
      projectId: owner,
      membership: "native-project",
      title,
      name: title,
      roots: typeof item.cwd === "string" && path.isAbsolute(item.cwd) ? [item.cwd] : [],
      state: item.state,
      nativeState: item.nativeState,
      running: item.running,
      agentAvailable: item.agentAvailable,
      child: item.origin === "subagent",
      live: item.live === true,
      persisted: item.persisted === true,
      createdAt: time(item.createdAt),
      updatedAt: time(item.updatedAt),
      capabilities: writeCapabilities(),
    };
  }
  #metadata(result) {
    return {
      observedAt: result.observedAt,
      complete: result.complete,
      bridgeInstance: result.bridgeInstance,
      hostProcessId: result.hostProcessId,
      transportMode: "local-readonly-bridge",
      controlAvailable: false,
    };
  }
  async listProjects() {
    const { result, projects } = await this.#projects();
    return { projects: projects.map(({ sessionIds, ...project }) => project), ...this.#metadata(result) };
  }
  async listWork(projectId) {
    if (!validId(projectId)) throw fail("DSH_BRIDGE_INVALID_INPUT");
    const directory = await this.#projects();
    const project = directory.projects.find((item) => item.nativeId === projectId);
    if (!project) throw fail("DSH_BRIDGE_PROJECT_NOT_FOUND");
    const result = await this.#request("session/list", { workspaceId: projectId });
    sameHost(directory.result, result);
    if (!Array.isArray(result.items)) throw fail("DSH_BRIDGE_INVALID_METADATA");
    const seen = new Set();
    const items = result.items.map((item) => {
      if (!validId(item?.sessionId) || seen.has(item.sessionId)) throw fail("DSH_BRIDGE_INVALID_METADATA");
      seen.add(item.sessionId);
      if (directory.membership.get(item.sessionId) !== projectId) throw fail("DSH_BRIDGE_PROJECT_MISMATCH");
      return this.#work(item, projectId);
    });
    return {
      items,
      ...this.#metadata(result),
      complete: directory.result.complete && result.complete && project.sessionIds.every((id) => seen.has(id)),
    };
  }
  async #readMember(nativeId, method) {
    if (!validId(nativeId)) throw fail("DSH_BRIDGE_INVALID_INPUT");
    const directory = await this.#projects();
    const owner = directory.membership.get(nativeId);
    if (!owner) throw fail("DSH_BRIDGE_WORK_NOT_REGISTERED");
    const result = await this.#request(method, { sessionId: nativeId });
    sameHost(directory.result, result);
    if (result.sessionId !== nativeId) throw fail("DSH_BRIDGE_PROJECT_MISMATCH");
    return {
      ...this.#work(result, owner),
      ...this.#metadata(result),
      complete: directory.result.complete && result.complete,
    };
  }
  async readWork(nativeId) {
    return this.#readMember(nativeId, "session/read");
  }
  async readStatus(nativeId) {
    return this.#readMember(nativeId, "session/status");
  }
  async readConversation(nativeId, { projectId, maxChars = 1600 } = {}) {
    if (!this.#allowConversationPreview) throw fail("DSH_BRIDGE_PREVIEW_DISABLED");
    if (!validId(nativeId) || !validId(projectId) || !integer(maxChars, 1, 2000))
      throw fail("DSH_BRIDGE_INVALID_INPUT");
    const socketBefore = await this.#identity();
    const directory = await this.#projects();
    if (directory.membership.get(nativeId) !== projectId) throw fail("DSH_BRIDGE_PROJECT_MISMATCH");
    let result;
    try {
      result = await this.#request("session/reply", { workspaceId: projectId, sessionId: nativeId });
    } catch (error) {
      if (["DSH_BRIDGE_METHOD_NOT_ALLOWED", "DSH_BRIDGE_REPLY_PREVIEW_UNSUPPORTED"].includes(error.code))
        throw fail("DSH_BRIDGE_PREVIEW_UNSUPPORTED");
      throw error;
    }
    sameHost(directory.result, result);
    if (result.sessionId !== nativeId || !Object.hasOwn(result, "latestReply")) throw fail("DSH_BRIDGE_INVALID_REPLY");
    const metadata = this.#work(result, projectId);
    let latestReply = null;
    if (result.latestReply !== null) {
      const reply = result.latestReply;
      if (
        !object(reply) ||
        typeof reply.text !== "string" ||
        !reply.text.trim() ||
        !validId(reply.id) ||
        !integer(reply.seq, 0, Number.MAX_SAFE_INTEGER) ||
        typeof reply.truncated !== "boolean" ||
        (reply.at !== null && (typeof reply.at !== "string" || !Number.isFinite(Date.parse(reply.at))))
      )
        throw fail("DSH_BRIDGE_INVALID_REPLY");
      const chars = Array.from(reply.text);
      if (chars.length > 2000) throw fail("DSH_BRIDGE_INVALID_REPLY");
      latestReply = {
        text: chars.slice(0, maxChars).join(""),
        at: reply.at,
        id: reply.id,
        seq: reply.seq,
        phase: null,
        truncated: reply.truncated || chars.length > maxChars,
        timeSource: reply.at === null ? "unknown" : "session-event",
      };
    }
    const after = await this.#projects();
    sameHost(result, after.result);
    if (after.membership.get(nativeId) !== projectId) throw fail("DSH_BRIDGE_PROJECT_MISMATCH");
    const socketAfter = await this.#identity();
    if (Object.keys(socketBefore).some((key) => socketBefore[key] !== socketAfter[key]))
      throw fail("DSH_BRIDGE_SOCKET_CHANGED");
    return {
      nativeId: metadata.nativeId,
      projectId: metadata.projectId,
      title: typeof result.title === "string" ? result.title : "",
      state: metadata.state,
      nativeState: metadata.nativeState,
      runtimeStateTrusted: metadata.agentAvailable,
      statusSource: metadata.agentAvailable ? "native-runtime" : "stored",
      updatedAt: metadata.updatedAt,
      observedAt: result.observedAt,
      complete: directory.result.complete && result.complete && after.result.complete,
      latestReply,
      ...(["REPLY_ABSENT", "REPLY_NO_TEXT"].includes(result.reason) ? { reason: result.reason } : {}),
    };
  }
  async continueWork() {
    throw fail("DSH_WRITE_DISABLED");
  }
  async cancelWork() {
    throw fail("DSH_WRITE_DISABLED");
  }
  async close() {
    this.#closed = true;
    for (const cancel of [...this.#pending]) cancel();
  }
}
