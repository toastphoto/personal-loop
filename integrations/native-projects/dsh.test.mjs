// Prevent fabricated project inventory, unsafe native writes, and leaked subscriptions or credentials.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { DshConnector } from "./dsh.mjs";
import { DshGatewayClient } from "./dsh-rpc.mjs";
import { ProjectCatalog, projectKey } from "./catalog.mjs";
import { observationEvent } from "./observe.mjs";

const workspace = { workspaceId: "w1", title: "Example", path: "/work/example", sessionIds: ["s1"] };
const row = {
  sessionId: "s1",
  cwd: "/work/example",
  running: false,
  agentAvailable: true,
  updatedAt: 1000,
  projections: { values: { title: "Task", inbox: { secret: "private-body" } } },
};
function transport({ frames = [{ type: "baseline", value: { items: [workspace] } }], rows = [row], fail } = {}) {
  const calls = [];
  let disposed = false;
  return {
    calls,
    get disposed() {
      return disposed;
    },
    async *stream(endpoint) {
      calls.push(endpoint);
      try {
        if (fail) throw fail;
        yield* frames;
      } finally {
        disposed = true;
      }
    },
    async call(endpoint, args) {
      calls.push({ endpoint, args });
      if (fail) throw fail;
      return endpoint === "session/list" ? { items: rows } : { accepted: true };
    },
    async close() {},
  };
}

test("unconfigured connection is blocked rather than an empty successful inventory", async () => {
  await assert.rejects(new DshConnector().listProjects(), { code: "DSH_GATEWAY_NOT_CONFIGURED" });
});
test("native workspace baseline projects only metadata and releases its subscription", async () => {
  const wire = transport();
  const c = new DshConnector({ transport: wire });
  const out = await c.listProjects();
  assert.equal(out.complete, true);
  assert.equal(out.projects[0].nativeId, "w1");
  assert.deepEqual(out.projects[0].roots, ["/work/example"]);
  assert.equal(wire.disposed, true);
  assert.equal(out.projects[0].capabilities.continue, false);
  assert.equal(JSON.stringify(out).includes("sessionIds"), false);
});
test("an incremental frame before the opening baseline is not complete inventory", async () => {
  await assert.rejects(
    new DshConnector({ transport: transport({ frames: [{ type: "upsert", workspace }] }) }).listProjects(),
    { code: "DSH_INVALID_BASELINE" },
  );
});
test("only baseline is consumed; future increments are not awaited", async () => {
  let advanced = false;
  let returned = false;
  const wire = {
    async *stream() {
      try {
        yield { type: "baseline", value: { items: [workspace] } };
        advanced = true;
        yield { type: "remove", workspaceId: "w1" };
      } finally {
        returned = true;
      }
    },
  };
  assert.equal((await new DshConnector({ transport: wire }).listProjects()).projects.length, 1);
  assert.equal(advanced, false);
  assert.equal(returned, true);
});
test("host errors stay errors and a stalled read is bounded", async () => {
  await assert.rejects(
    new DshConnector({
      transport: transport({ fail: Object.assign(new Error("private"), { code: "remote-access/denied" }) }),
    }).listProjects(),
    { code: "DSH_REMOTE_ERROR" },
  );
  const wire = {
    stream() {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          return new Promise(() => {});
        },
        return() {
          return Promise.resolve({ done: true });
        },
      };
    },
  };
  await assert.rejects(new DshConnector({ transport: wire, timeoutMs: 20 }).listProjects(), { code: "DSH_TIMEOUT" });
});
test("work is linked by native membership, not by a coincidentally matching cwd", async () => {
  const wire = transport({ rows: [row, { ...row, sessionId: "other" }] });
  const c = new DshConnector({ transport: wire });
  const out = await c.listWork("w1");
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].nativeId, "s1");
  assert.equal(JSON.stringify(out).includes("private-body"), false);
  assert.equal((await c.readWork("s1")).name, "Task");
  await assert.rejects(c.listWork("missing"), { code: "DSH_PROJECT_NOT_FOUND" });
});
test("writes are off by default and do not even query the host", async () => {
  const wire = transport();
  const c = new DshConnector({ transport: wire });
  await assert.rejects(c.continueWork({ nativeId: "s1", text: "go", requestId: "r1" }), { code: "DSH_WRITE_DISABLED" });
  await assert.rejects(c.cancelWork({ nativeId: "s1" }), { code: "DSH_WRITE_DISABLED" });
  assert.equal(wire.calls.length, 0);
});
test("busy, unknown-status and child sessions cannot be continued", async () => {
  for (const input of [
    { ...row, running: true },
    { ...row, running: undefined },
    { ...row, origin: "subagent" },
    { ...row, projections: { values: { inbox: { "next-turn": [{ text: "private queued input" }] } } } },
  ]) {
    const wire = transport({ rows: [input] });
    const c = new DshConnector({ transport: wire, writeEnabled: true });
    await assert.rejects(c.continueWork({ nativeId: "s1", text: "go", requestId: "r1" }));
    assert.equal(
      wire.calls.some((x) => x.endpoint === "session/prompt"),
      false,
    );
  }
});
test("continue targets the original session and carries caller idempotency identity", async () => {
  const wire = transport();
  const c = new DshConnector({ transport: wire, writeEnabled: true });
  const out = await c.continueWork({ nativeId: "s1", text: "go", requestId: "r1" });
  assert.equal(out.accepted, true);
  assert.equal(out.completed, false);
  assert.deepEqual(wire.calls.at(-1), {
    endpoint: "session/prompt",
    args: { request: { sessionId: "s1", requestId: "r1", mode: "queue", content: [{ type: "text", text: "go" }] } },
  });
});
test("cancel only requests cancellation of a currently live running session", async () => {
  const wire = transport({ rows: [{ ...row, running: true }] });
  const c = new DshConnector({ transport: wire, writeEnabled: true });
  const out = await c.cancelWork({ nativeId: "s1" });
  assert.equal(out.stopped, false);
  assert.equal(wire.calls.at(-1).endpoint, "session/cancel");
});

test("real HTTP and native WebSocket use an independent official /connect credential, not a browser cookie", async (t) => {
  const requests = [];
  const sockets = new Set();
  const wsMessages = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, cookie: req.headers.cookie });
    if (req.url.startsWith("/connect?")) {
      res.writeHead(302, { location: "./api/remote.mux", "set-cookie": "dsh-api=test-operator; HttpOnly; Path=/" });
      res.end();
      return;
    }
    let body = "";
    req.on("data", (x) => (body += x));
    req.on("end", () => {
      const message = JSON.parse(body);
      assert.equal(message.type, "client-request");
      assert.deepEqual(message.payload, { args: { _request: {} } });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          type: "server-response",
          rpcId: message.rpcId,
          result: { ok: true, value: { items: [row] } },
        }),
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    assert.equal(req.headers.cookie, "dsh-api=test-operator");
    assert.equal(req.url, "/api/remote.mux");
    const accept = createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    let incoming = Buffer.alloc(0);
    socket.on("data", (data) => {
      incoming = Buffer.concat([incoming, data]);
      while (incoming.length >= 2) {
        const opcode = incoming[0] & 15;
        let length = incoming[1] & 127;
        let off = 2;
        if (length === 126) {
          if (incoming.length < 4) return;
          length = incoming.readUInt16BE(2);
          off = 4;
        }
        assert.notEqual(length, 127, "fixture frames stay bounded");
        if (incoming.length < off + 4 + length) return;
        const mask = incoming.subarray(off, off + 4);
        const payload = Buffer.from(incoming.subarray(off + 4, off + 4 + length));
        incoming = incoming.subarray(off + 4 + length);
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        const message = JSON.parse(payload.toString());
        wsMessages.push(message);
        if (message.type === "open") {
          const bytes = Buffer.from(
            JSON.stringify({
              type: "item",
              streamId: message.streamId,
              value: { type: "baseline", value: { items: [workspace] } },
            }),
          );
          const head =
            bytes.length < 126
              ? Buffer.from([0x81, bytes.length])
              : Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]);
          socket.write(Buffer.concat([head, bytes]));
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new DshGatewayClient({
    gatewayUrl: "http://127.0.0.1:" + server.address().port,
    launchTokenEnv: "DSH_TEST_LAUNCH",
    env: { DSH_TEST_LAUNCH: "synthetic-launch" },
  });
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const c = new DshConnector({ transport: client });
  assert.equal((await c.listProjects()).projects.length, 1);
  assert.equal((await c.readWork("s1")).nativeId, "s1");
  assert.equal(requests[0].cookie, undefined);
  assert.match(requests[0].url, /interactions=none/);
  assert.equal(requests.at(-1).cookie, "dsh-api=test-operator");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    wsMessages.some((x) => x.type === "cancel"),
    true,
  );
});
test("missing launch authorization and unsafe URLs are rejected without reading files or making a request", async () => {
  assert.throws(() => new DshGatewayClient({ gatewayUrl: "http://example.com" }), { code: "DSH_UNSAFE_GATEWAY" });
  const client = new DshGatewayClient({ gatewayUrl: "http://127.0.0.1:1234", launchTokenEnv: "ABSENT", env: {} });
  await assert.rejects(client.call("session/list", { _request: {} }), { code: "DSH_AUTHORIZATION_REQUIRED" });
});

test("HTTP authorization rejection does not expose launch token or response text", async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(401);
    res.end("sensitive upstream detail");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new DshGatewayClient({
    gatewayUrl: "http://127.0.0.1:" + server.address().port,
    launchTokenEnv: "DSH_TEST_AUTH",
    env: { DSH_TEST_AUTH: "do-not-echo-this" },
  });
  await assert.rejects(
    client.connect(),
    (e) =>
      e.code === "DSH_AUTHORIZATION_REQUIRED" &&
      !String(e).includes("do-not-echo-this") &&
      !String(e).includes("sensitive"),
  );
});

test("Catalog reads a native DSH member and observation detects idle to running", async () => {
  const moving = { ...row };
  const c = new DshConnector({ transport: transport({ rows: [moving] }) });
  const catalog = new ProjectCatalog({ dsh: c });
  await catalog.refresh();
  const key = projectKey("dsh", "local", "w1");
  const read = await catalog.readWork(key, "s1");
  assert.equal(read.projectId, "w1");
  assert.equal(read.membership, "native-project");
  assert.equal(read.state, "idle");
  const project = catalog.resolve(key).project;
  const initial = observationEvent("example", { project, tasks: await catalog.listWork(key) });
  moving.running = true;
  const next = observationEvent("example", { project, tasks: await catalog.listWork(key) });
  assert.notEqual(initial.fingerprint, next.fingerprint);
  assert.equal((await c.readWork("s1")).nativeState, "running");
});
test("readWork never assigns membership from cwd and rejects inconsistent native membership", async () => {
  const c = new DshConnector({ transport: transport({ rows: [{ ...row, sessionId: "unassigned" }] }) });
  assert.equal((await c.readWork("unassigned")).projectId, null);
  const ambiguous = transport({
    frames: [{ type: "baseline", value: { items: [workspace, { ...workspace, workspaceId: "w2" }] } }],
  });
  await assert.rejects(new DshConnector({ transport: ambiguous }).readWork("s1"), { code: "DSH_PROJECT_MISMATCH" });
});
test("write guards run after reads and their original error codes prevent continue and cancel RPCs", async () => {
  for (const action of ["continueWork", "cancelWork"]) {
    const wire = transport({ rows: [{ ...row, running: action === "cancelWork" }] });
    const c = new DshConnector({ transport: wire, writeEnabled: true });
    const rejected = Object.assign(new Error("paused"), { code: "CONTROL_REVISION_CHANGED" });
    await assert.rejects(
      c[action]({
        nativeId: "s1",
        text: "go",
        requestId: "r1",
        beforeMutation() {
          assert.ok(wire.calls.some((x) => x.endpoint === "session/list"));
          throw rejected;
        },
      }),
      (e) => e === rejected,
    );
    assert.equal(
      wire.calls.some((x) => ["session/prompt", "session/cancel"].includes(x.endpoint)),
      false,
    );
  }
});
test("a final transport guard rechecks pause after asynchronous connection setup", async () => {
  let paused = false;
  let mutations = 0;
  const wire = transport();
  const base = wire.call;
  wire.call = async (endpoint, args, options) => {
    if (endpoint === "session/prompt") {
      await Promise.resolve();
      options.beforeMutation();
      mutations++;
      return { accepted: true };
    }
    return base(endpoint, args, options);
  };
  const c = new DshConnector({ transport: wire, writeEnabled: true });
  await assert.rejects(
    c.continueWork({
      nativeId: "s1",
      text: "go",
      requestId: "r1",
      beforeMutation() {
        if (paused) throw Object.assign(new Error("paused"), { code: "LOOP_NOT_ACTIVE" });
        queueMicrotask(() => {
          paused = true;
        });
      },
    }),
    { code: "LOOP_NOT_ACTIVE" },
  );
  assert.equal(mutations, 0);
});
