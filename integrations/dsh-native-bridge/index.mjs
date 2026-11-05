// This plugin borrows already-active public Host services. It never opens shared persistence or a second Host.
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, chmod, unlink } from "node:fs/promises";

export const name = "personal-loop-native-metadata";
export const inject = ["workspaceRegistry", "sessionQuery", "agents"];
const methods = new Set(["workspace/list", "session/list", "session/read", "session/status"]);
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const failure = (code) => Object.assign(new Error(code), { code });
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const validId = (value) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 256;
function integer(value, fallback, min, max) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw failure("INVALID_CONFIG");
  return result;
}
function configuration(value = {}) {
  if (
    !text(value.socketPath) ||
    !path.isAbsolute(value.socketPath) ||
    value.socketPath.includes("\0") ||
    Buffer.byteLength(value.socketPath) > 100 ||
    process.platform === "win32"
  )
    throw failure("INVALID_SOCKET_PATH");
  return {
    socketPath: path.resolve(value.socketPath),
    requestTimeoutMs: integer(value.requestTimeoutMs, 3000, 1, 60000),
    maxMessageBytes: integer(value.maxMessageBytes, 16384, 64, 1048576),
    maxResponseBytes: integer(value.maxResponseBytes, 2097152, 1024, 16777216),
    maxClients: integer(value.maxClients, 8, 1, 32),
    maxRequestsPerClient: integer(value.maxRequestsPerClient, 4, 1, 16),
  };
}
function request(value) {
  if (
    !plain(value) ||
    !validId(value.id) ||
    typeof value.method !== "string" ||
    !plain(value.params ?? {}) ||
    Object.keys(value).some((k) => !["id", "method", "params"].includes(k))
  )
    throw failure("INVALID_REQUEST");
  if (!methods.has(value.method)) throw failure("METHOD_NOT_ALLOWED");
  const params = value.params ?? {};
  const fields =
    value.method === "workspace/list" ? [] : value.method === "session/list" ? ["workspaceId"] : ["sessionId"];
  if (
    Object.keys(params).some((k) => !fields.includes(k)) ||
    Object.values(params).some((v) => !validId(v)) ||
    ((value.method === "session/read" || value.method === "session/status") && !validId(params.sessionId))
  )
    throw failure("INVALID_REQUEST");
  return { id: value.id, method: value.method, params };
}
function workspaces(ctx) {
  const rows = ctx.workspaceRegistry.list();
  if (!Array.isArray(rows)) throw failure("INVALID_NATIVE_METADATA");
  const ids = new Set();
  const members = new Set();
  return rows.map((row) => {
    if (
      !validId(String(row.id ?? "")) ||
      ids.has(String(row.id)) ||
      typeof row.title !== "string" ||
      !text(row.path) ||
      !path.isAbsolute(row.path) ||
      !Array.isArray(row.sessionIds)
    )
      throw failure("INVALID_NATIVE_METADATA");
    ids.add(String(row.id));
    const sessionIds = row.sessionIds.map((id) => {
      if (!validId(String(id)) || members.has(String(id))) throw failure("INVALID_NATIVE_METADATA");
      members.add(String(id));
      return String(id);
    });
    return {
      workspaceId: String(row.id),
      title: row.title,
      path: row.path,
      sessionIds,
      createdAt: finite(row.createdAt),
      updatedAt: finite(row.updatedAt),
    };
  });
}
async function read(ctx, method, params, signal, instanceId) {
  const projects = workspaces(ctx);
  const observedAt = () => new Date().toISOString();
  const envelope = (result) => ({
    ...result,
    observedAt: observedAt(),
    complete: true,
    bridgeInstance: instanceId,
    hostProcessId: process.pid,
  });
  if (method === "workspace/list") return envelope({ items: projects });
  if (params.workspaceId && !projects.some((p) => p.workspaceId === params.workspaceId))
    throw failure("WORKSPACE_NOT_FOUND");
  const owner = new Map(projects.flatMap((p) => p.sessionIds.map((id) => [id, p.workspaceId])));
  const rows = await ctx.sessionQuery.listSessions(signal);
  if (!Array.isArray(rows)) throw failure("INVALID_NATIVE_METADATA");
  const known = new Set();
  const items = rows.map((row) => {
    const header = row?.header;
    if (!plain(header) || !validId(String(header.id ?? "")) || known.has(String(header.id)))
      throw failure("INVALID_NATIVE_METADATA");
    const sessionId = String(header.id);
    known.add(sessionId);
    const agent = ctx.agents.get(sessionId);
    const nativeState =
      agent?.status === "running" ? "running" : agent?.status === "idle" ? "idle" : agent ? "unknown" : "not_loaded";
    return {
      sessionId,
      projectId: owner.get(sessionId) ?? null,
      cwd: typeof header.cwd === "string" ? header.cwd : null,
      title: null,
      createdAt: finite(header.createdAt),
      updatedAt: null,
      running: nativeState === "running" ? true : nativeState === "idle" ? false : null,
      state: ["running", "idle"].includes(nativeState) ? nativeState : "unknown",
      nativeState,
      agentAvailable: agent !== undefined,
      origin: header.origin === "subagent" ? "subagent" : "root",
      live: row.live === true,
      persisted: row.persisted === true,
    };
  });
  if (method === "session/list") {
    const selected = params.workspaceId ? items.filter((item) => item.projectId === params.workspaceId) : items;
    const result = envelope({ items: selected });
    result.complete = projects
      .filter((p) => !params.workspaceId || p.workspaceId === params.workspaceId)
      .every((p) => p.sessionIds.every((id) => known.has(id)));
    return result;
  }
  const item = items.find((item) => item.sessionId === params.sessionId);
  if (!item) throw failure("SESSION_NOT_FOUND");
  return envelope(item);
}
async function deadline(action, ms, cancelled) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, cancelled]);
  let timer;
  let abort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => action(signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(failure("READ_TIMEOUT"));
        }, ms);
      }),
      new Promise((_, reject) => {
        abort = () => reject(failure("READ_CANCELLED"));
        if (cancelled.aborted) abort();
        else cancelled.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    cancelled.removeEventListener("abort", abort);
    controller.abort();
  }
}
async function privateSocketPath(socketPath) {
  const directory = path.dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o777) !== 0o700
  )
    throw failure("PRIVATE_DIRECTORY_REQUIRED");
  try {
    await lstat(socketPath);
    throw failure("SOCKET_PATH_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function startBridge(ctx, input = {}) {
  const config = configuration(input);
  if (!ctx?.workspaceRegistry?.list || !ctx?.sessionQuery?.listSessions || !ctx?.agents?.get)
    throw failure("HOST_SERVICES_UNAVAILABLE");
  await privateSocketPath(config.socketPath);
  const clients = new Set();
  const connections = new Set();
  const requests = new Set();
  const instanceId = randomUUID();
  let owned;
  let closing;
  const server = net.createServer((socket) => {
    // Rejected half-open peers are still owned sockets and must not outlive Host disposal.
    connections.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => connections.delete(socket));
    if (clients.size >= config.maxClients) {
      socket.end(JSON.stringify({ id: null, ok: false, error: { code: "CLIENT_LIMIT" } }) + "\n", () =>
        socket.destroy(),
      );
      return;
    }
    clients.add(socket);
    let buffer = Buffer.alloc(0);
    let pending = 0;
    const lifetime = new AbortController();
    socket.on("close", () => {
      clients.delete(socket);
      lifetime.abort();
    });
    function send(value) {
      if (socket.destroyed || !socket.writable) return;
      let encoded = JSON.stringify(value) + "\n";
      if (Buffer.byteLength(encoded) > config.maxResponseBytes)
        encoded = JSON.stringify({ id: value.id, ok: false, error: { code: "RESPONSE_TOO_LARGE" } }) + "\n";
      if (socket.writableLength > config.maxResponseBytes * 2) {
        socket.destroy();
        return;
      }
      socket.write(encoded);
    }
    async function handle(line) {
      let id = null;
      try {
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          throw failure("INVALID_JSON");
        }
        if (validId(raw?.id)) id = raw.id;
        const message = request(raw);
        if (pending >= config.maxRequestsPerClient) throw failure("REQUEST_LIMIT");
        pending++;
        try {
          const result = await deadline(
            (signal) => read(ctx, message.method, message.params, signal, instanceId),
            config.requestTimeoutMs,
            lifetime.signal,
          );
          send({ id, ok: true, result });
        } finally {
          pending--;
        }
      } catch (error) {
        const known = new Set([
          "INVALID_JSON",
          "INVALID_REQUEST",
          "METHOD_NOT_ALLOWED",
          "REQUEST_LIMIT",
          "READ_TIMEOUT",
          "READ_CANCELLED",
          "WORKSPACE_NOT_FOUND",
          "SESSION_NOT_FOUND",
          "INVALID_NATIVE_METADATA",
        ]);
        send({ id, ok: false, error: { code: known.has(error?.code) ? error.code : "READ_FAILED" } });
      }
    }
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newline = buffer.indexOf(10);
        if ((newline < 0 && buffer.length > config.maxMessageBytes) || newline > config.maxMessageBytes) {
          send({ id: null, ok: false, error: { code: "MESSAGE_TOO_LARGE" } });
          socket.end();
          buffer = Buffer.alloc(0);
          return;
        }
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        const operation = handle(line);
        requests.add(operation);
        operation.finally(() => requests.delete(operation));
      }
    });
  });
  const close = () =>
    (closing ??= (async () => {
      for (const client of connections) client.destroy();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...requests]);
      if (owned) {
        try {
          const current = await lstat(config.socketPath);
          if (current.isSocket() && current.dev === owned.dev && current.ino === owned.ino)
            await unlink(config.socketPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    })());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.socketPath, resolve);
    });
    owned = await lstat(config.socketPath);
    await chmod(config.socketPath, 0o600);
    server.on("error", () => {
      void close();
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { socketPath: config.socketPath, instanceId, close };
}

export async function apply(ctx, config) {
  const bridge = await startBridge(ctx, config);
  ctx.effect(() => () => bridge.close(), "personal-loop.native-metadata");
}
