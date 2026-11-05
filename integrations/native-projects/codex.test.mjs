// Guard proxy protocol failures, partial pages, private history leakage, and accidental duplicate or busy-thread writes.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexConnector } from "./codex.mjs";
import { CodexRpcProxy } from "./codex-rpc.mjs";

function child(onRequest = () => {}) {
  const p = new EventEmitter();
  p.stdin = new PassThrough();
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.killed = false;
  p.kill = () => {
    p.killed = true;
    queueMicrotask(() => p.emit("exit", null, "SIGTERM"));
  };
  let buffer = "";
  p.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n");
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line) onRequest(JSON.parse(line), p);
    }
  });
  return p;
}
const result = (p, id, value) => p.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: value }) + "\n");
function fakeConnector(handler, options = {}) {
  const calls = [];
  const transport = {
    async connect() {},
    async close() {},
    async request(method, params) {
      calls.push({ method, params });
      return handler(method, params, calls);
    },
  };
  return { connector: new CodexConnector({ transportFactory: () => transport, ...options }), calls };
}
const thread = (state = "idle", extra = {}) => ({
  id: "t1",
  projectId: "p1",
  name: "Example",
  status: { type: state },
  updatedAt: 10,
  preview: "PRIVATE",
  turns: [],
  ...extra,
});

test("proxy initializes, preserves fragmented UTF-8 frames, and ignores notifications", async () => {
  let args;
  const p = child((q, c) => {
    if (q.method === "initialize") result(c, q.id, {});
    if (q.method === "project/list") {
      c.stdout.write('{"jsonrpc":"2.0","method":"thread/status/changed","params":{}}\n');
      const bytes = Buffer.from(JSON.stringify({ id: q.id, result: { data: [{ name: "项目" }] } }) + "\n");
      const cut = bytes.indexOf(Buffer.from("项目")) + 1;
      c.stdout.write(bytes.subarray(0, cut));
      c.stdout.write(bytes.subarray(cut));
    }
  });
  const rpc = new CodexRpcProxy({
    socket: "/tmp/approved.sock",
    spawn: (command, argv) => {
      args = argv;
      return p;
    },
  });
  await rpc.connect();
  assert.deepEqual((await rpc.request("project/list", {})).data, [{ name: "项目" }]);
  assert.deepEqual(args, ["app-server", "proxy", "--sock", "/tmp/approved.sock"]);
  await rpc.close();
  assert.equal(p.killed, true);
});

test("RPC failures return safe codes without echoing server details", async () => {
  const p = child((q, c) =>
    q.method === "initialize"
      ? result(c, q.id, {})
      : q.id && c.stdout.write(JSON.stringify({ id: q.id, error: { code: -32001, message: "PRIVATE" } }) + "\n"),
  );
  const rpc = new CodexRpcProxy({ spawn: () => p });
  await rpc.connect();
  await assert.rejects(
    rpc.request("project/list", {}),
    (e) => e.code === "CODEX_RPC_ERROR" && e.rpcCode === -32001 && !e.message.includes("PRIVATE"),
  );
  await rpc.close();
});

test("timeout closes only the owned proxy and rejects pending requests", async () => {
  const p = child((q, c) => q.method === "initialize" && result(c, q.id, {}));
  const rpc = new CodexRpcProxy({ timeoutMs: 25, spawn: () => p });
  await rpc.connect();
  await assert.rejects(rpc.request("project/list", {}), { code: "CODEX_TIMEOUT" });
  assert.equal(p.killed, true);
});

test("process exit and malformed protocol reject initialization", async () => {
  const p = child(() => queueMicrotask(() => p.emit("exit", 1, null)));
  await assert.rejects(new CodexRpcProxy({ spawn: () => p }).connect(), { code: "CODEX_DISCONNECTED" });
  const bad = child((q, c) => c.stdout.write("not-json\n"));
  await assert.rejects(new CodexRpcProxy({ spawn: () => bad }).connect(), { code: "CODEX_PROTOCOL_ERROR" });
});

test("native project pagination preserves identity and only returns project fields", async () => {
  const { connector } = fakeConnector((method, p) => ({
    data: [
      { id: p.cursor ? "p2" : "p1", name: "Same", roots: [{ path: "/tmp/project" }], metadata: { private: "PRIVATE" } },
    ],
    nextCursor: p.cursor ? null : "next",
  }));
  const r = await connector.listProjects();
  assert.equal(r.complete, true);
  assert.equal(r.projects.length, 2);
  assert.deepEqual(
    r.projects.map((p) => p.nativeId),
    ["p1", "p2"],
  );
  assert.equal(r.projects[0].capabilities.continue, false);
  assert.ok(!JSON.stringify(r).includes("PRIVATE"));
});

test("repeated pagination cursors and malformed pages fail instead of claiming complete inventory", async () => {
  const { connector } = fakeConnector(() => ({ data: [], nextCursor: "repeat" }));
  await assert.rejects(connector.listProjects(), { code: "CODEX_PAGINATION_LOOP" });
  const bad = fakeConnector(() => ({ projects: [] })).connector;
  await assert.rejects(bad.listProjects(), { code: "CODEX_PROTOCOL_ERROR" });
});

test("list and read work return metadata only without preview or turn content", async () => {
  const { connector, calls } = fakeConnector((method) =>
    method === "thread/list"
      ? { data: [thread("active", { turns: [{ items: ["PRIVATE"] }] })], nextCursor: null }
      : { thread: thread() },
  );
  const list = await connector.listWork("p1");
  const read = await connector.readWork("t1");
  assert.equal(list.items[0].state, "running");
  assert.equal(read.state, "idle");
  assert.equal(calls[0].params.projectId, "p1");
  assert.equal(calls[0].params.useStateDbOnly, true);
  assert.equal(calls[1].params.includeTurns, false);
  assert.ok(!JSON.stringify([list, read]).includes("PRIVATE"));
});

test("writes are disabled before any native call", async () => {
  const { connector, calls } = fakeConnector(() => {
    throw Error("must not call");
  });
  await assert.rejects(connector.continueWork({ nativeId: "t1", text: "task", requestId: "r1" }), {
    code: "CODEX_WRITE_DISABLED",
  });
  await assert.rejects(connector.cancelWork({ nativeId: "t1", turnId: "turn1" }), { code: "CODEX_WRITE_DISABLED" });
  assert.equal(calls.length, 0);
});

test("busy, unavailable and noninteractive threads cannot be continued", async () => {
  for (const value of [thread("active"), thread("systemError"), thread("idle", { canAcceptDirectInput: false })]) {
    const { connector, calls } = fakeConnector(() => ({ thread: value }), { writeEnabled: true });
    await assert.rejects(connector.continueWork({ nativeId: "t1", text: "task", requestId: "r1" }), {
      code: "CODEX_WORK_NOT_IDLE",
    });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["thread/read"],
    );
  }
});

test("resume errors never create a replacement chat", async () => {
  const { connector, calls } = fakeConnector(
    (method) => {
      if (method === "thread/read") return { thread: thread("notLoaded") };
      throw Object.assign(Error("unavailable"), { code: "CODEX_RPC_ERROR" });
    },
    { writeEnabled: true },
  );
  await assert.rejects(connector.continueWork({ nativeId: "t1", text: "task", requestId: "r1" }));
  assert.deepEqual(
    calls.map((c) => c.method),
    ["thread/read", "thread/resume"],
  );
});

test("continuation preserves session and policy and does not repeat a request in this instance", async () => {
  const { connector, calls } = fakeConnector(
    (method) => (method === "turn/start" ? { turn: { id: "turn1", status: "inProgress" } } : { thread: thread() }),
    { writeEnabled: true },
  );
  const args = { nativeId: "t1", text: "task", requestId: "r1" };
  const first = await connector.continueWork(args);
  assert.deepEqual(await connector.continueWork(args), first);
  assert.equal(first.completed, false);
  const write = calls.find((c) => c.method === "turn/start");
  assert.deepEqual(write.params, {
    threadId: "t1",
    input: [{ type: "text", text: "task" }],
    clientUserMessageId: "r1",
  });
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 1);
  await assert.rejects(connector.continueWork({ ...args, text: "changed" }), { code: "CODEX_REQUEST_CONFLICT" });
});

test("cancellation checks exact active turn and reports request acceptance, not completion", async () => {
  const { connector, calls } = fakeConnector(
    (method) => {
      if (method === "thread/read") return { thread: thread("active") };
      if (method === "thread/turns/list")
        return { data: [{ id: "turn1", status: "inProgress", items: [] }], nextCursor: null };
      return {};
    },
    { writeEnabled: true },
  );
  await assert.rejects(connector.cancelWork({ nativeId: "t1", turnId: "stale" }), { code: "CODEX_TURN_MISMATCH" });
  const r = await connector.cancelWork({ nativeId: "t1", turnId: "turn1" });
  assert.equal(r.accepted, true);
  assert.equal(r.completed, false);
  assert.equal(calls.filter((c) => c.method === "turn/interrupt").length, 1);
  assert.equal(calls.find((c) => c.method === "thread/turns/list").params.itemsView, "none");
});

test("isolated catalogue mode never advertises or permits control even if writeEnabled is set", async () => {
  const { connector, calls } = fakeConnector(
    (method) =>
      method === "thread/read"
        ? { thread: thread("notLoaded") }
        : { data: [{ id: "p1", name: "Project", roots: [] }], nextCursor: null },
    { mode: "isolated-readonly-api", writeEnabled: true },
  );
  const r = await connector.listProjects();
  assert.equal(r.controlAvailable, false);
  assert.equal(r.projects[0].capabilities.continue, false);
  await assert.rejects(connector.continueWork({ nativeId: "t1", text: "task", requestId: "r1" }), {
    code: "CODEX_WRITE_DISABLED",
  });
  const metadata = await connector.readWork("t1");
  assert.equal(metadata.runtimeStateTrusted, false);
  assert.equal(metadata.state, "unknown");
  assert.equal(calls.length, 2);
});

test("transport readonly allowlist prevents hidden resume or control requests", async () => {
  let args;
  const p = child((q, c) => q.id && result(c, q.id, {}));
  const rpc = new CodexRpcProxy({
    mode: "isolated-readonly-api",
    spawn: (command, argv) => {
      args = argv;
      return p;
    },
  });
  await rpc.connect();
  assert.deepEqual(args, ["app-server", "--stdio"]);
  await assert.rejects(rpc.request("thread/resume", { threadId: "t1" }), { code: "CODEX_CONTROL_UNAVAILABLE" });
  await rpc.close();
});

test("unknown write outcomes remain unretried in the same instance", async () => {
  const { connector, calls } = fakeConnector(
    (method) => {
      if (method === "turn/start") throw Object.assign(Error("timeout"), { code: "CODEX_TIMEOUT" });
      return { thread: thread() };
    },
    { writeEnabled: true },
  );
  const input = { nativeId: "t1", text: "task", requestId: "r1" };
  await assert.rejects(connector.continueWork(input), { code: "CODEX_TIMEOUT" });
  await assert.rejects(connector.continueWork(input), { code: "CODEX_TIMEOUT" });
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 1);
});

test("a thread becoming busy during resume is not prompted", async () => {
  const { connector, calls } = fakeConnector(
    (method) => ({ thread: thread(method === "thread/read" ? "idle" : "active") }),
    { writeEnabled: true },
  );
  await assert.rejects(connector.continueWork({ nativeId: "t1", text: "task", requestId: "r1" }), {
    code: "CODEX_WORK_NOT_IDLE",
  });
  assert.equal(
    calls.some((c) => c.method === "turn/start"),
    false,
  );
});

test("optional legacy lookup labels directory association without fabricating native membership", async () => {
  const { connector, calls } = fakeConnector(
    (method, params) => {
      if (method === "project/list")
        return { data: [{ id: "p1", name: "Project", roots: [{ path: "/tmp/approved" }] }], nextCursor: null };
      if (params.projectId === null)
        return {
          data: [thread("notLoaded", { projectId: null, cwd: "/tmp/approved", id: "legacy" })],
          nextCursor: null,
        };
      return { data: [thread()], nextCursor: null };
    },
    { includeUnassignedByRoot: true, mode: "isolated-readonly-api" },
  );
  const result = await connector.listWork("p1");
  assert.deepEqual(
    result.items.map((x) => [x.nativeId, x.projectId, x.nativeProjectId, x.membership]),
    [
      ["t1", "p1", "p1", "native-project"],
      ["legacy", "p1", null, "cwd-unassigned"],
    ],
  );
  assert.deepEqual(calls.find((x) => x.params.projectId === null).params.cwd, ["/tmp/approved"]);
  assert.equal(result.controlAvailable, false);
});

test("legacy lookup rejects other directories or native assignments", async () => {
  const { connector } = fakeConnector(
    (method, params) => {
      if (method === "project/list")
        return { data: [{ id: "p1", name: "Project", roots: [{ path: "/tmp/approved" }] }], nextCursor: null };
      if (params.projectId === null) return { data: [thread("idle", { projectId: null, cwd: "/tmp/other" })] };
      return { data: [] };
    },
    { includeUnassignedByRoot: true },
  );
  await assert.rejects(connector.listWork("p1"), { code: "CODEX_PROJECT_MISMATCH" });
});

test("extra CLI arguments cannot change readonly mode into a daemon or network listener", () => {
  for (const commandArgs of [["daemon", "start"], ["--listen", "ws://127.0.0.1:9999"], ["--startup-sign-out"]]) {
    assert.throws(() => new CodexRpcProxy({ mode: "isolated-readonly-api", commandArgs }), {
      code: "CODEX_CONFIG_ERROR",
    });
  }
});

test("pause during resume prevents turn/start and preserves the control error", async () => {
  let paused = false;
  const blocked = Object.assign(new Error("paused"), { code: "LOOP_NOT_ACTIVE" });
  const { connector, calls } = fakeConnector(
    (method) => {
      if (method === "thread/resume") paused = true;
      return { thread: thread() };
    },
    { writeEnabled: true },
  );
  await assert.rejects(
    connector.continueWork({
      nativeId: "t1",
      text: "task",
      requestId: "pause-race",
      beforeMutation() {
        if (paused) throw blocked;
      },
    }),
    (e) => e === blocked,
  );
  assert.equal(
    calls.some((c) => c.method === "turn/start"),
    false,
  );
});

test("revision change during cancellation lookup prevents interrupt and preserves its code", async () => {
  let revision = 1;
  const changed = Object.assign(new Error("changed"), { code: "CONTROL_REVISION_CHANGED" });
  const { connector, calls } = fakeConnector(
    (method) => {
      if (method === "thread/read") return { thread: thread("active") };
      if (method === "thread/turns/list") {
        revision = 2;
        return { data: [{ id: "turn1", status: "inProgress", items: [] }] };
      }
      return {};
    },
    { writeEnabled: true },
  );
  await assert.rejects(
    connector.cancelWork({
      nativeId: "t1",
      turnId: "turn1",
      beforeMutation() {
        if (revision !== 1) throw changed;
      },
    }),
    (e) => e === changed,
  );
  assert.equal(
    calls.some((c) => c.method === "turn/interrupt"),
    false,
  );
});

test("guard runs after transport connection awaits immediately before the write request", async () => {
  let connected = 0,
    paused = false;
  const calls = [];
  const blocked = Object.assign(new Error("paused"), { code: "LOOP_NOT_ACTIVE" });
  const transport = {
    async connect() {
      connected++;
      if (connected === 3) paused = true;
    },
    async close() {},
    async request(method) {
      calls.push(method);
      return { thread: thread(), turn: { id: "turn1" } };
    },
  };
  const connector = new CodexConnector({ writeEnabled: true, transportFactory: () => transport });
  await assert.rejects(
    connector.continueWork({
      nativeId: "t1",
      text: "task",
      requestId: "connect-pause",
      beforeMutation() {
        if (paused) throw blocked;
      },
    }),
    (e) => e === blocked,
  );
  assert.deepEqual(calls, ["thread/read", "thread/resume"]);
});

test("isolated readWork uses metadata-only thread/read and never treats fresh-host state as desktop idle", async () => {
  const { connector, calls } = fakeConnector(
    () => ({ thread: thread("idle", { preview: "PRIVATE", turns: [{ items: ["PRIVATE_BODY"] }] }) }),
    { mode: "isolated-readonly-api", writeEnabled: true },
  );
  const result = await connector.readWork("t1", { projectId: "p1" });
  assert.equal(result.projectId, "p1");
  assert.equal(result.state, "unknown");
  assert.equal(result.nativeState, "idle");
  assert.equal(result.runtimeStateTrusted, false);
  assert.equal(result.statusSource, "stored");
  assert.equal(result.canContinue, false);
  assert.equal(result.canCancel, false);
  assert.deepEqual(calls, [{ method: "thread/read", params: { threadId: "t1", includeTurns: false } }]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("readonly transport permits exact metadata reads but refuses full-history and every control method", async () => {
  const calls = [];
  const p = child((q, c) => {
    calls.push(q);
    if (q.id) result(c, q.id, {});
  });
  const rpc = new CodexRpcProxy({ mode: "isolated-readonly-api", spawn: () => p });
  await rpc.connect();
  await rpc.request("thread/read", { threadId: "t1", includeTurns: false });
  for (const params of [{ threadId: "t1" }, { threadId: "t1", includeTurns: true }]) {
    await assert.rejects(rpc.request("thread/read", params), { code: "CODEX_HISTORY_READ_DENIED" });
  }
  for (const method of ["thread/resume", "turn/start", "turn/interrupt"]) {
    await assert.rejects(rpc.request(method, { threadId: "t1" }), { code: "CODEX_CONTROL_UNAVAILABLE" });
  }
  assert.equal(calls.filter((q) => q.method === "thread/read").length, 1);
  await rpc.close();
});

test("readWork labels only explicitly permitted exact-root unassigned legacy sessions", async () => {
  const { connector } = fakeConnector(
    (method) =>
      method === "project/list"
        ? { data: [{ id: "p1", name: "Project", roots: [{ path: "/tmp/approved" }] }], nextCursor: null }
        : { thread: thread("notLoaded", { projectId: null, cwd: "/tmp/approved" }) },
    { mode: "isolated-readonly-api", includeUnassignedByRoot: true },
  );
  const scoped = await connector.readWork("t1", { projectId: "p1" });
  assert.equal(scoped.projectId, "p1");
  assert.equal(scoped.nativeProjectId, null);
  assert.equal(scoped.membership, "cwd-unassigned");
  assert.equal(scoped.state, "unknown");
  const unscoped = await connector.readWork("t1");
  assert.equal(unscoped.projectId, null);
  assert.equal(unscoped.membership, "unassigned");
});

test("readWork rejects disabled legacy mapping, another native project, missing membership, and nonexact roots", async () => {
  for (const [value, enabled] of [
    [{ projectId: null, cwd: "/tmp/approved" }, false],
    [{ projectId: "p2", cwd: "/tmp/approved" }, true],
    [{ projectId: undefined, cwd: "/tmp/approved" }, true],
    [{ projectId: null, cwd: "/tmp/approved/child" }, true],
  ]) {
    const { connector } = fakeConnector(
      (method) =>
        method === "project/list"
          ? { data: [{ id: "p1", name: "Project", roots: [{ path: "/tmp/approved" }] }] }
          : { thread: thread("notLoaded", value) },
      { mode: "isolated-readonly-api", includeUnassignedByRoot: enabled },
    );
    await assert.rejects(connector.readWork("t1", { projectId: "p1" }), { code: "CODEX_PROJECT_MISMATCH" });
  }
});

const previewTurn = (items = [], extra = {}) => ({
  id: "turn1",
  status: "completed",
  itemsView: "full",
  completedAt: 20,
  items,
  ...extra,
});
const replyItem = (text, extra = {}) => ({ type: "agentMessage", id: "reply1", phase: "final_answer", text, ...extra });
const previewOptions = { mode: "isolated-readonly-api", allowConversationPreview: true };

test("conversation preview is opt-in and rejects invalid limits before any native read", async () => {
  const disabled = fakeConnector(() => {
    throw Error("must not read");
  });
  await assert.rejects(disabled.connector.readConversation("t1", { projectId: "p1" }), {
    code: "CODEX_PREVIEW_DISABLED",
  });
  assert.equal(disabled.calls.length, 0);
  const enabled = fakeConnector(() => {
    throw Error("must not read");
  }, previewOptions);
  for (const maxChars of [0, -1, 1.5, Infinity, 100000])
    await assert.rejects(enabled.connector.readConversation("t1", { projectId: "p1", maxChars }), {
      code: "CODEX_INVALID_INPUT",
    });
  assert.equal(enabled.calls.length, 0);
});

test("selected project identity is checked before reply reads, including legacy exact-root association", async () => {
  for (const extra of [
    { projectId: "p2" },
    { projectId: null, cwd: "/tmp/approved/child" },
    { projectId: undefined },
  ]) {
    const f = fakeConnector(
      (method) =>
        method === "project/list"
          ? { data: [{ id: "p1", name: "Project", roots: [{ path: "/tmp/approved" }] }], nextCursor: null }
          : { thread: thread("notLoaded", extra) },
      { ...previewOptions, includeUnassignedByRoot: true },
    );
    await assert.rejects(f.connector.readConversation("t1", { projectId: "p1" }), { code: "CODEX_PROJECT_MISMATCH" });
    assert.equal(
      f.calls.some((c) => c.method === "thread/turns/list"),
      false,
    );
  }
  const legacy = fakeConnector(
    (method) =>
      method === "project/list"
        ? { data: [{ id: "p1", name: "Project", roots: [{ path: "/tmp/approved" }] }], nextCursor: null }
        : method === "thread/read"
          ? { thread: thread("notLoaded", { projectId: null, cwd: "/tmp/approved" }) }
          : { data: [previewTurn([replyItem("legacy answer")])], nextCursor: null },
    { ...previewOptions, includeUnassignedByRoot: true },
  );
  const result = await legacy.connector.readConversation("t1", { projectId: "p1" });
  assert.equal(result.projectId, "p1");
  assert.equal(result.latestReply.text, "legacy answer");
  assert.equal(result.runtimeStateTrusted, false);
});

test("bounded preview selects only the newest assistant text without leaking reasoning or tool bodies", async () => {
  const f = fakeConnector(
    (method) =>
      method === "thread/read"
        ? { thread: thread("active") }
        : {
            data: [
              previewTurn([
                { type: "reasoning", id: "r", content: ["PRIVATE_THINKING"] },
                { type: "commandExecution", id: "cmd", aggregatedOutput: "PRIVATE_TOOL" },
                replyItem("early", { id: "reply0", phase: "commentary" }),
                replyItem("latest update", { phase: "partial_answer" }),
                { type: "mcpToolCall", id: "tool", result: "PRIVATE_RAW" },
              ]),
            ],
            nextCursor: "older",
          },
    previewOptions,
  );
  const r = await f.connector.readConversation("t1", { projectId: "p1" });
  assert.equal(r.latestReply.text, "latest update");
  assert.equal(r.latestReply.phase, "partial_answer");
  assert.equal(r.latestReply.id, "reply1");
  assert.equal(r.latestReply.at, "1970-01-01T00:00:20.000Z");
  assert.equal(r.state, "unknown");
  assert.equal(r.statusSource, "stored");
  assert.equal(r.runtimeStateTrusted, false);
  assert.equal(r.complete, true);
  assert.ok(!JSON.stringify(r).includes("PRIVATE"));
  assert.deepEqual(
    f.calls.filter((c) => c.method === "thread/turns/list").map((c) => c.params),
    [{ threadId: "t1", limit: 1, sortDirection: "desc", itemsView: "full" }],
  );
  assert.ok(f.calls.every((c) => ["thread/read", "thread/turns/list"].includes(c.method)));
  const metadata = await f.connector.readWork("t1", { projectId: "p1" });
  assert.equal(metadata.latestReply, undefined);
  assert.ok(!JSON.stringify(metadata).includes("latest update"));
});

test("preview clips Unicode text explicitly and never invents an unavailable reply timestamp", async () => {
  const f = fakeConnector(
    (method) =>
      method === "thread/read"
        ? { thread: thread() }
        : {
            data: [previewTurn([replyItem("🙂回复后续内容", { phase: null })], { completedAt: null, startedAt: 1 })],
            nextCursor: null,
          },
    previewOptions,
  );
  const r = await f.connector.readConversation("t1", { projectId: "p1", maxChars: 3 });
  assert.equal(r.latestReply.text, "🙂回复");
  assert.equal(r.latestReply.truncated, true);
  assert.equal(r.latestReply.at, null);
  assert.equal(r.latestReply.phase, null);
});

test("empty latest turns scan at most three turns, and absence differs from a bounded incomplete scan", async () => {
  const f = fakeConnector(
    (method, params) =>
      method === "thread/read"
        ? { thread: thread() }
        : {
            data: [previewTurn(params.cursor ? [replyItem("prior final")] : [], { id: params.cursor ? "old" : "new" })],
            nextCursor: params.cursor ? null : "older",
          },
    previewOptions,
  );
  assert.equal((await f.connector.readConversation("t1", { projectId: "p1" })).latestReply.text, "prior final");
  assert.equal(f.calls.filter((c) => c.method === "thread/turns/list").length, 2);
  const absent = fakeConnector(
    (method) => (method === "thread/read" ? { thread: thread() } : { data: [], nextCursor: null }),
    previewOptions,
  );
  const a = await absent.connector.readConversation("t1", { projectId: "p1" });
  assert.equal(a.latestReply, null);
  assert.equal(a.complete, true);
  assert.equal(a.reason, "CODEX_REPLY_ABSENT");
  let pages = 0;
  const limited = fakeConnector(
    (method) =>
      method === "thread/read"
        ? { thread: thread() }
        : {
            data: [previewTurn([], { id: "turn" + ++pages })],
            nextCursor: "cursor" + pages,
          },
    previewOptions,
  );
  const l = await limited.connector.readConversation("t1", { projectId: "p1" });
  assert.equal(l.latestReply, null);
  assert.equal(l.complete, false);
  assert.equal(l.reason, "CODEX_REPLY_SCAN_LIMIT");
  assert.equal(pages, 3);
});

test("partial or malformed turn pages cannot claim complete reply evidence", async () => {
  const partial = fakeConnector(
    (method) =>
      method === "thread/read"
        ? { thread: thread() }
        : {
            data: [previewTurn([replyItem("incomplete")], { itemsView: "summary" })],
            nextCursor: null,
          },
    previewOptions,
  );
  const p = await partial.connector.readConversation("t1", { projectId: "p1" });
  assert.equal(p.complete, false);
  assert.equal(p.latestReply, null);
  assert.equal(p.reason, "CODEX_REPLY_NOT_FULL");
  for (const response of [
    { data: [previewTurn(), previewTurn()] },
    { data: [], nextCursor: "not-progressing" },
    { data: [{ id: "x", itemsView: "full" }] },
  ]) {
    const f = fakeConnector((method) => (method === "thread/read" ? { thread: thread() } : response), previewOptions);
    await assert.rejects(f.connector.readConversation("t1", { projectId: "p1" }), { code: "CODEX_PROTOCOL_ERROR" });
  }
});

test("a project move during the reply read prevents returning the newly out-of-scope body", async () => {
  let read = 0;
  const f = fakeConnector(
    (method) =>
      method === "thread/read"
        ? { thread: thread("idle", { projectId: ++read === 1 ? "p1" : "p2" }) }
        : { data: [previewTurn([replyItem("DO_NOT_RETURN")])], nextCursor: null },
    previewOptions,
  );
  await assert.rejects(f.connector.readConversation("t1", { projectId: "p1" }), { code: "CODEX_PROJECT_MISMATCH" });
});

test("readonly RPC grants only explicit bounded turn pages and retains full-history and write denials", async () => {
  const valid = { threadId: "t1", limit: 1, sortDirection: "desc", itemsView: "full" };
  for (const optIn of [false, true]) {
    const calls = [];
    const p = child((q, c) => {
      calls.push(q);
      if (q.id) result(c, q.id, {});
    });
    const rpc = new CodexRpcProxy({ mode: "isolated-readonly-api", allowConversationPreview: optIn, spawn: () => p });
    await rpc.connect();
    if (!optIn) await assert.rejects(rpc.request("thread/turns/list", valid), { code: "CODEX_CONTROL_UNAVAILABLE" });
    else {
      await rpc.request("thread/turns/list", valid);
      await rpc.request("thread/turns/list", { ...valid, cursor: "opaque-page" });
      for (const invalid of [
        { ...valid, limit: 2 },
        { ...valid, sortDirection: "asc" },
        { ...valid, itemsView: "none" },
        { ...valid, cursor: 42 },
        { ...valid, includeReasoning: true },
        { ...valid, threadId: "" },
      ])
        await assert.rejects(rpc.request("thread/turns/list", invalid), { code: "CODEX_PREVIEW_READ_DENIED" });
      assert.equal(calls.filter((c) => c.method === "thread/turns/list").length, 2);
    }
    await assert.rejects(rpc.request("thread/read", { threadId: "t1", includeTurns: true }), {
      code: "CODEX_HISTORY_READ_DENIED",
    });
    await assert.rejects(rpc.request("turn/start", { threadId: "t1" }), { code: "CODEX_CONTROL_UNAVAILABLE" });
    await rpc.close();
  }
});
