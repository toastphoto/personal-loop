// Guard native metadata privacy, explicit read-only RPC, and same-user UDS lifecycle.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, stat, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startBridge, apply } from "./index.mjs";

function fake() {
  const workspace = {
    id: "w1",
    title: "Company demo",
    path: "/work/company",
    sessionIds: ["s1"],
    createdAt: 10,
    updatedAt: 20,
  };
  const record = {
    header: { id: "s1", cwd: "/work/company", createdAt: 30, content: "private-body", credentials: "private-key" },
    live: true,
    persisted: true,
  };
  let running = false;
  return {
    workspace,
    record,
    setRunning(value) {
      running = value;
    },
    workspaceRegistry: {
      list() {
        return [workspace];
      },
    },
    sessionQuery: {
      async listSessions() {
        return [record];
      },
    },
    agents: {
      get(id) {
        return id === "s1"
          ? {
              status: running ? "running" : "idle",
              prompt() {
                throw new Error("must not invoke model");
              },
            }
          : undefined;
      },
    },
  };
}
async function fixture(t, options = {}, ctx = fake()) {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-bridge-test-"));
  const socketPath = path.join(dir, "private", "native.sock");
  const bridge = await startBridge(ctx, { socketPath, ...options });
  t.after(async () => {
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { ctx, bridge, socketPath, dir };
}
async function client(socketPath) {
  const socket = net.connect(socketPath);
  await once(socket, "connect");
  let buffer = "";
  const waiting = [];
  const queued = [];
  socket.setEncoding("utf8");
  socket.on("data", (data) => {
    buffer += data;
    let pos;
    while ((pos = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, pos);
      buffer = buffer.slice(pos + 1);
      const value = JSON.parse(line);
      const resolve = waiting.shift();
      if (resolve) resolve(value);
      else queued.push(value);
    }
  });
  return {
    socket,
    request(method, params = {}, id = "r1") {
      socket.write(JSON.stringify({ id, method, params }) + "\n");
      return queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiting.push(resolve));
    },
    next() {
      return queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}
test("real UDS returns project membership and session metadata with no private fields", async (t) => {
  const f = await fixture(t);
  const c = await client(f.socketPath);
  t.after(() => c.socket.destroy());
  const projects = await c.request("workspace/list");
  assert.equal(projects.ok, true);
  assert.equal(projects.result.items[0].workspaceId, "w1");
  assert.deepEqual(projects.result.items[0].sessionIds, ["s1"]);
  const sessions = await c.request("session/list", { workspaceId: "w1" });
  assert.equal(sessions.result.items[0].projectId, "w1");
  assert.equal(sessions.result.items[0].running, false);
  const text = JSON.stringify(sessions);
  assert.equal(text.includes("private-body"), false);
  assert.equal(text.includes("private-key"), false);
  assert.equal(text.includes("credentials"), false);
  f.ctx.setRunning(true);
  assert.equal((await c.request("session/status", { sessionId: "s1" })).result.running, true);
});
test("only fixed read-only operations and parameter fields are allowed", async (t) => {
  const f = await fixture(t);
  const c = await client(f.socketPath);
  t.after(() => c.socket.destroy());
  for (const method of ["session/prompt", "session/cancel", "workspace/create", "../../config", "proxy"])
    assert.equal((await c.request(method)).error.code, "METHOD_NOT_ALLOWED");
  assert.equal((await c.request("session/list", { body: "secret" })).error.code, "INVALID_REQUEST");
  assert.equal((await c.request("session/read", { sessionId: "missing" })).error.code, "SESSION_NOT_FOUND");
});
test("multiple clients can read without stealing a subscription or task", async (t) => {
  const f = await fixture(t);
  const clients = await Promise.all([client(f.socketPath), client(f.socketPath), client(f.socketPath)]);
  t.after(() => clients.forEach((c) => c.socket.destroy()));
  assert.deepEqual(
    (await Promise.all(clients.map((c, i) => c.request("workspace/list", {}, String(i))))).map((x) => x.ok),
    [true, true, true],
  );
});
test("native reads have a deadline and failures do not reveal underlying details", async (t) => {
  const ctx = fake();
  ctx.sessionQuery.listSessions = () => new Promise(() => {});
  const f = await fixture(t, { requestTimeoutMs: 25 }, ctx);
  const c = await client(f.socketPath);
  t.after(() => c.socket.destroy());
  assert.equal((await c.request("session/list")).error.code, "READ_TIMEOUT");
  ctx.sessionQuery.listSessions = async () => {
    throw new Error("private-server-detail");
  };
  const failure = await c.request("session/list");
  assert.equal(failure.error.code, "READ_FAILED");
  assert.equal(JSON.stringify(failure).includes("private-server-detail"), false);
});
test("private directory/socket permissions and dispose remove only this socket", async (t) => {
  const f = await fixture(t);
  assert.equal((await stat(path.dirname(f.socketPath))).mode & 0o777, 0o700);
  assert.equal((await stat(f.socketPath)).mode & 0o777, 0o600);
  const c = await client(f.socketPath);
  const closed = once(c.socket, "close");
  await f.bridge.close();
  await closed;
  await assert.rejects(stat(f.socketPath), { code: "ENOENT" });
});
test("pre-existing socket paths and non-private parent directories are refused", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-bridge-refuse-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "shared"), { mode: 0o755 });
  await assert.rejects(startBridge(fake(), { socketPath: path.join(dir, "shared", "native.sock") }), {
    code: "PRIVATE_DIRECTORY_REQUIRED",
  });
  const socketPath = path.join(dir, "existing.sock");
  await writeFile(socketPath, "keep");
  await assert.rejects(startBridge(fake(), { socketPath }), { code: "SOCKET_PATH_EXISTS" });
  assert.equal(await readFile(socketPath, "utf8"), "keep");
});
test("malformed and oversized messages cannot trigger native reads", async (t) => {
  let reads = 0;
  const ctx = fake();
  ctx.workspaceRegistry.list = () => {
    reads++;
    return [];
  };
  const f = await fixture(t, { maxMessageBytes: 128 }, ctx);
  const c = await client(f.socketPath);
  t.after(() => c.socket.destroy());
  c.socket.write("{not-json}\n");
  assert.equal((await c.next()).error.code, "INVALID_JSON");
  c.socket.write("x".repeat(129));
  assert.equal((await c.next()).error.code, "MESSAGE_TOO_LARGE");
  assert.equal(reads, 0);
});
test("plugin disposal closes the UDS through its registered lifecycle cleanup", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-plugin-life-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = fake();
  const disposers = [];
  ctx.effect = (fn) => {
    disposers.push(fn());
  };
  await apply(ctx, { socketPath: path.join(dir, "native.sock") });
  assert.equal(disposers.length, 1);
  await disposers[0]();
  await assert.rejects(stat(path.join(dir, "native.sock")), { code: "ENOENT" });
});

test("client and response limits fail closed without partial native metadata", async (t) => {
  const f = await fixture(t, { maxClients: 1, maxResponseBytes: 1024 });
  const first = await client(f.socketPath);
  t.after(() => first.socket.destroy());
  const second = await client(f.socketPath);
  t.after(() => second.socket.destroy());
  assert.equal((await second.next()).error.code, "CLIENT_LIMIT");
  f.ctx.workspace.title = "long".repeat(1000);
  const response = await first.request("workspace/list");
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "RESPONSE_TOO_LARGE");
  assert.equal("result" in response, false);
});
test("dispose cancels an in-flight native metadata read and closes its client", async (t) => {
  let observedAbort = false;
  let begin;
  const started = new Promise((resolve) => {
    begin = resolve;
  });
  const ctx = fake();
  ctx.sessionQuery.listSessions = (signal) =>
    new Promise((_, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          observedAbort = true;
          reject(new Error("cancelled"));
        },
        { once: true },
      );
      begin();
    });
  const f = await fixture(t, { requestTimeoutMs: 1000 }, ctx);
  const c = await client(f.socketPath);
  c.socket.write(JSON.stringify({ id: "pending", method: "session/list", params: {} }) + "\n");
  await started;
  const disconnected = once(c.socket, "close");
  await f.bridge.close();
  await disconnected;
  assert.equal(observedAbort, true);
});
test("unloaded sessions preserve unknown runtime state and missing headers mark partial results", async (t) => {
  const ctx = fake();
  ctx.agents.get = () => undefined;
  const f = await fixture(t, {}, ctx);
  const c = await client(f.socketPath);
  t.after(() => c.socket.destroy());
  const cold = await c.request("session/read", { sessionId: "s1" });
  assert.equal(cold.result.running, null);
  assert.equal(cold.result.nativeState, "not_loaded");
  ctx.workspace.sessionIds.push("missing");
  const list = await c.request("session/list", { workspaceId: "w1" });
  assert.equal(list.result.complete, false);
});

test("a rejected half-open UDS client cannot keep Host disposal waiting", async (t) => {
  const f = await fixture(t, { maxClients: 1 });
  const accepted = await client(f.socketPath);
  const rejected = net.createConnection({ path: f.socketPath, allowHalfOpen: true });
  await once(rejected, "connect");
  const [data] = await once(rejected, "data");
  assert.equal(JSON.parse(data.toString()).error.code, "CLIENT_LIMIT");
  let timer;
  try {
    const closed = await Promise.race([
      f.bridge.close().then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 100);
      }),
    ]);
    assert.equal(closed, true, "rejected clients must not keep server.close pending");
  } finally {
    clearTimeout(timer);
    rejected.destroy();
    accepted.socket.destroy();
  }
});

function previewHost() {
  const ctx = fake();
  const calls = [];
  ctx.replyCalls = calls;
  ctx.sessionQuery.listEvents = async (sessionId) => {
    calls.push({ method: "listEvents", sessionId });
    return [
      { sessionId, seq: 0, type: "turn/start", time: 1000, surface: "log-only" },
      { sessionId, seq: 1, type: "assistant/message", time: 2000, surface: "current" },
    ];
  };
  ctx.sessionQuery.readEvent = async (request, signal) => {
    calls.push({ method: "readEvent", request });
    signal.throwIfAborted();
    return {
      session: { id: "s1", private: "private-header" },
      target: {
        seq: 1,
        type: "assistant/message",
        time: 2000,
        data: {
          message: {
            content: [
              { type: "reasoning", text: "private-reasoning" },
              { type: "text", text: "可见回复" },
              { type: "tool-call", name: "private-tool", arguments: "private-input" },
            ],
          },
        },
      },
      events: ["private-neighbor"],
    };
  };
  return ctx;
}
test("reply previews require explicit plugin opt-in and exact workspace/session input", async (t) => {
  const ctx = previewHost();
  const f = await fixture(t, {}, ctx);
  const c = await client(f.socketPath);
  t.after(() => c.socket.destroy());
  assert.equal(
    (await c.request("session/reply", { workspaceId: "w1", sessionId: "s1" })).error.code,
    "REPLY_PREVIEW_DISABLED",
  );
  assert.equal(ctx.replyCalls.length, 0);
  const g = await fixture(t, { allowReplyPreview: true }, previewHost());
  const d = await client(g.socketPath);
  t.after(() => d.socket.destroy());
  for (const params of [
    { sessionId: "s1" },
    { workspaceId: "w1" },
    { workspaceId: "w1", sessionId: "s1", includeAll: "yes" },
  ])
    assert.equal((await d.request("session/reply", params)).error.code, "INVALID_REQUEST");
  assert.equal(
    (await d.request("session/reply", { workspaceId: "other", sessionId: "s1" })).error.code,
    "WORKSPACE_NOT_FOUND",
  );
  g.ctx.workspace.sessionIds = [];
  assert.equal(
    (await d.request("session/reply", { workspaceId: "w1", sessionId: "s1" })).error.code,
    "SESSION_WORKSPACE_MISMATCH",
  );
  assert.equal(g.ctx.replyCalls.length, 0);
});
test("reply preview returns only bounded visible text, event time and exact event identity", async (t) => {
  const f = await fixture(t, { allowReplyPreview: true }, previewHost());
  const c = await client(f.socketPath);
  t.after(() => c.socket.destroy());
  const r = await c.request("session/reply", { workspaceId: "w1", sessionId: "s1" });
  assert.equal(r.ok, true);
  assert.equal(r.result.projectId, "w1");
  assert.equal(r.result.latestReply.text, "可见回复");
  assert.equal(r.result.latestReply.at, "1970-01-01T00:00:02.000Z");
  assert.equal(r.result.latestReply.seq, 1);
  assert.equal(r.result.updatedAt, null);
  assert.equal(r.result.title, null);
  assert.ok(!JSON.stringify(r).includes("private-"));
  assert.deepEqual(f.ctx.replyCalls[1].request, { sessionId: "s1", seq: 1, before: 0, after: 0 });
  f.ctx.sessionQuery.readEvent = async () => ({
    session: { id: "s1" },
    target: {
      seq: 1,
      type: "assistant/message",
      time: 2000,
      data: { message: { content: [{ type: "text", text: "🙂".repeat(2100) }] } },
    },
  });
  const long = await c.request("session/reply", { workspaceId: "w1", sessionId: "s1" });
  assert.equal(Array.from(long.result.latestReply.text).length, 2000);
  assert.equal(long.result.latestReply.truncated, true);
  assert.equal((await c.request("session/read", { sessionId: "s1" })).result.latestReply, undefined);
});
test("reply identity mismatch and a concurrent workspace move never return a body", async (t) => {
  for (const fault of ["session", "seq", "type", "move"]) {
    const ctx = previewHost(),
      original = ctx.sessionQuery.readEvent;
    ctx.sessionQuery.readEvent = async (...args) => {
      const result = await original(...args);
      if (fault === "session") result.session.id = "another";
      if (fault === "seq") result.target.seq = 9;
      if (fault === "type") result.target.type = "user/message";
      if (fault === "move") ctx.workspace.sessionIds = [];
      return result;
    };
    const f = await fixture(t, { allowReplyPreview: true }, ctx);
    const c = await client(f.socketPath);
    t.after(() => c.socket.destroy());
    const r = await c.request("session/reply", { workspaceId: "w1", sessionId: "s1" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, fault === "move" ? "SESSION_WORKSPACE_MISMATCH" : "INVALID_NATIVE_REPLY");
    assert.ok(!JSON.stringify(r).includes("可见回复"));
  }
});
test("no assistant text and unavailable reply API are explicit without fake timestamps", async (t) => {
  const f = await fixture(t, { allowReplyPreview: true }, previewHost());
  const c = await client(f.socketPath);
  t.after(() => c.socket.destroy());
  f.ctx.sessionQuery.listEvents = async () => [];
  const empty = await c.request("session/reply", { workspaceId: "w1", sessionId: "s1" });
  assert.equal(empty.result.latestReply, null);
  assert.equal(empty.result.reason, "REPLY_ABSENT");
  delete f.ctx.sessionQuery.readEvent;
  const unsupported = await c.request("session/reply", { workspaceId: "w1", sessionId: "s1" });
  assert.equal(unsupported.error.code, "REPLY_PREVIEW_UNSUPPORTED");
});
