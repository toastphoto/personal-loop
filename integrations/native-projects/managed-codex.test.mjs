// Guard ownership, uncertain side effects, pause races, restart replay, and completion/usage provenance.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ManagedCodexRpc } from "./managed-rpc.mjs";
import { ManagedCodexExecutor } from "./managed-codex.mjs";

const guard = () => {};
const params = {
  projectId: "p1",
  cwd: "/tmp/company",
  goalId: "goal1",
  goal: "Read a status report",
  beforeMutation: guard,
};
function harness(t, handler, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "managed-codex-test-"));
  const stateFile = path.join(directory, "owned.db");
  const calls = [];
  let events;
  const factory = (callbacks) => {
    events = callbacks;
    return {
      async connect() {},
      async close() {},
      async request(method, input) {
        calls.push({ method, input });
        if (method === "thread/turns/list" && !["notLoaded", "summary", "full"].includes(input.itemsView))
          throw Object.assign(new Error("unsupported TurnItemsView"), { code: "MANAGED_TEST_INVALID_ITEMS_VIEW" });
        if (handler) {
          const r = await handler(method, input, callbacks);
          if (r !== undefined) return r;
        }
        if (method === "project/read") return { project: { id: "p1", roots: [{ path: "/tmp/company" }] } };
        if (method === "thread/start" || method === "thread/resume" || method === "thread/read")
          return {
            thread: { id: "owned1", projectId: "p1", cwd: "/tmp/company", status: { type: "idle" }, turns: [] },
          };
        if (method === "turn/start") return { turn: { id: "turn1", status: "inProgress" } };
        if (method === "thread/turns/list") return { data: [{ id: "turn1", status: "inProgress" }] };
        return {};
      },
    };
  };
  const executor = new ManagedCodexExecutor({ stateFile, enabled: true, transportFactory: factory, ...options });
  t.after(async () => {
    await executor.close({ force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  return { executor, calls, stateFile, factory, notify: (method, data) => events.onNotification(method, data) };
}

test("default disabled and explicit target, goal, and guard are required before creation", async (t) => {
  const h = harness(t, null, { enabled: false });
  await assert.rejects(h.executor.createOwnedSession(params), { code: "MANAGED_DISABLED" });
  assert.equal(h.calls.length, 0);
});

test("creation binds original project and read-only permissions without starting a model", async (t) => {
  const h = harness(t);
  const result = await h.executor.createOwnedSession(params);
  assert.equal(result.nativeId, "owned1");
  assert.equal(result.owned, true);
  const call = h.calls.find((x) => x.method === "thread/start");
  assert.equal(call.input.projectId, "p1");
  assert.equal(call.input.cwd, "/tmp/company");
  assert.equal(call.input.sandbox, "read-only");
  assert.equal(call.input.approvalPolicy, "never");
  assert.equal(call.input.ephemeral, false);
  assert.equal(call.input.threadSource, "personal-loop");
  assert.equal(
    h.calls.some((x) => x.method === "turn/start"),
    false,
  );
  assert.equal((await h.executor.createOwnedSession(params)).nativeId, "owned1");
  assert.equal(h.calls.filter((x) => x.method === "thread/start").length, 1);
});

test("unknown creation is persisted and does not recreate after restart", async (t) => {
  const h = harness(t, (method) => {
    if (method === "thread/start") throw Object.assign(Error("connection lost"), { code: "RPC_DISCONNECTED" });
  });
  await assert.rejects(h.executor.createOwnedSession(params), { code: "RPC_DISCONNECTED" });
  await h.executor.close({ force: true });
  const next = new ManagedCodexExecutor({ stateFile: h.stateFile, enabled: true, transportFactory: h.factory });
  try {
    await assert.rejects(next.createOwnedSession(params), { code: "MANAGED_OUTCOME_UNKNOWN" });
  } finally {
    await next.close({ force: true });
  }
  assert.equal(h.calls.filter((x) => x.method === "thread/start").length, 1);
});

test("unregistered user threads are never read, resumed or cancelled", async (t) => {
  const h = harness(t);
  await assert.rejects(h.executor.readOwned("user-thread"), { code: "MANAGED_NOT_OWNED" });
  await assert.rejects(
    h.executor.continueOwned({ threadId: "user-thread", requestId: "r1", text: "hello", beforeMutation: guard }),
    { code: "MANAGED_NOT_OWNED" },
  );
  await assert.rejects(h.executor.cancelOwned({ threadId: "user-thread", turnId: "turn1", beforeMutation: guard }), {
    code: "MANAGED_NOT_OWNED",
  });
  assert.equal(h.calls.length, 0);
});

test("continuation intent survives unknown response and is never repeated", async (t) => {
  const h = harness(t, (method) => {
    if (method === "turn/start") throw Object.assign(Error("timeout"), { code: "RPC_TIMEOUT" });
  });
  await h.executor.createOwnedSession(params);
  const input = { threadId: "owned1", requestId: "r1", text: "inspect", beforeMutation: guard };
  await assert.rejects(h.executor.continueOwned(input), { code: "RPC_TIMEOUT" });
  await assert.rejects(h.executor.continueOwned(input), { code: "MANAGED_OUTCOME_UNKNOWN" });
  assert.equal(h.calls.filter((x) => x.method === "turn/start").length, 1);
});

test("pause after resume prevents model invocation and retains exact error", async (t) => {
  let paused = false;
  const error = Object.assign(Error("paused"), { code: "LOOP_NOT_ACTIVE" });
  const h = harness(t, (method) => {
    if (method === "thread/resume") paused = true;
  });
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({ threadId: "owned1", requestId: "first", text: "first", beforeMutation: guard });
  h.notify("turn/completed", { threadId: "owned1", turn: { id: "turn1", status: "completed" } });
  const count = h.calls.length;
  await assert.rejects(
    h.executor.continueOwned({
      threadId: "owned1",
      requestId: "r1",
      text: "inspect",
      beforeMutation() {
        if (paused) throw error;
      },
    }),
    (e) => e === error,
  );
  assert.equal(
    h.calls.slice(count).some((x) => x.method === "turn/start"),
    false,
  );
});

test("a second process cannot own the same executor ledger", async (t) => {
  const h = harness(t);
  assert.throws(
    () => new ManagedCodexExecutor({ stateFile: h.stateFile, enabled: true, transportFactory: h.factory }),
    { code: "MANAGED_ALREADY_OWNED" },
  );
});

test("real completion and cumulative/last usage are projected without model output", async (t) => {
  const h = harness(t);
  await h.executor.createOwnedSession(params);
  const submitted = await h.executor.continueOwned({
    threadId: "owned1",
    requestId: "r1",
    text: "inspect",
    beforeMutation: guard,
  });
  assert.equal(submitted.completionVerified, false);
  h.notify("thread/tokenUsage/updated", {
    threadId: "owned1",
    turnId: "turn1",
    tokenUsage: {
      total: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, totalTokens: 110 },
      last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, totalTokens: 110 },
    },
  });
  h.notify("turn/completed", {
    threadId: "owned1",
    turn: { id: "turn1", status: "completed", completedAt: 123, items: [{ text: "PRIVATE_MODEL_OUTPUT" }] },
  });
  const record = await h.executor.readOwned("owned1", { refresh: false });
  assert.equal(record.state, "idle");
  assert.equal(record.lastCompletion.status, "completed");
  assert.equal(record.usage.total.inputTokens, 100);
  assert.equal(record.usage.last.outputTokens, 10);
  assert.ok(!JSON.stringify(record).includes("PRIVATE_MODEL_OUTPUT"));
  assert.ok(!readFileSync(h.stateFile).includes(Buffer.from("PRIVATE_MODEL_OUTPUT")));
  await h.executor.close();
});

test("close refuses to discard an active owned turn unless force is explicit", async (t) => {
  const h = harness(t);
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({ threadId: "owned1", requestId: "r1", text: "inspect", beforeMutation: guard });
  await assert.rejects(h.executor.close(), { code: "MANAGED_ACTIVE_TURNS" });
  await h.executor.close({ force: true });
});

test("cancellation only targets the owned recorded turn and requires later completion evidence", async (t) => {
  let active = false;
  const h = harness(t, (method) => {
    if (method === "thread/read" && active)
      return { thread: { id: "owned1", projectId: "p1", cwd: "/tmp/company", status: { type: "active" } } };
  });
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({ threadId: "owned1", requestId: "r1", text: "inspect", beforeMutation: guard });
  active = true;
  await assert.rejects(h.executor.cancelOwned({ threadId: "owned1", turnId: "wrong", beforeMutation: guard }), {
    code: "MANAGED_TURN_MISMATCH",
  });
  const r = await h.executor.cancelOwned({ threadId: "owned1", turnId: "turn1", beforeMutation: guard });
  assert.equal(r.accepted, true);
  assert.equal(r.completionVerified, false);
  h.notify("turn/completed", { threadId: "owned1", turn: { id: "turn1", status: "interrupted" } });
  assert.equal((await h.executor.readOwned("owned1", { refresh: false })).lastCompletion.status, "interrupted");
});

test("late completion of an older turn never marks a newer turn complete", async (t) => {
  let turns = 0;
  const h = harness(t, (method) => {
    if (method === "turn/start") return { turn: { id: "turn" + ++turns, status: "inProgress" } };
  });
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({ threadId: "owned1", requestId: "r1", text: "first", beforeMutation: guard });
  h.notify("turn/completed", { threadId: "owned1", turn: { id: "turn1", status: "completed" } });
  await h.executor.continueOwned({ threadId: "owned1", requestId: "r2", text: "second", beforeMutation: guard });
  h.notify("turn/completed", { threadId: "owned1", turn: { id: "turn1", status: "completed" } });
  const row = await h.executor.readOwned("owned1", { refresh: false });
  assert.equal(row.state, "running");
  assert.equal(row.activeTurnId, "turn2");
  assert.equal(row.completionVerified, false);
});

test("completion delivered before turn/start response is replayed after durable acceptance", async (t) => {
  const h = harness(t, (method, input, events) => {
    if (method === "turn/start") {
      events.onNotification("turn/completed", { threadId: "owned1", turn: { id: "turn1", status: "completed" } });
      return { turn: { id: "turn1", status: "inProgress" } };
    }
  });
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({ threadId: "owned1", requestId: "r1", text: "first", beforeMutation: guard });
  assert.equal((await h.executor.readOwned("owned1", { refresh: false })).state, "idle");
});

test("identity mismatch blocks continuation before resume or model work", async (t) => {
  let mismatch = false;
  const h = harness(t, (method) => {
    if (method === "thread/read" && mismatch)
      return { thread: { id: "owned1", projectId: "different", cwd: "/tmp/company", status: { type: "idle" } } };
  });
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({ threadId: "owned1", requestId: "first", text: "first", beforeMutation: guard });
  h.notify("turn/completed", { threadId: "owned1", turn: { id: "turn1", status: "completed" } });
  mismatch = true;
  const count = h.calls.length;
  await assert.rejects(
    h.executor.continueOwned({ threadId: "owned1", requestId: "r1", text: "next", beforeMutation: guard }),
    { code: "MANAGED_IDENTITY_MISMATCH" },
  );
  assert.equal(
    h.calls.slice(count).some((x) => x.method === "thread/resume" || x.method === "turn/start"),
    false,
  );
});

test("unknown execution cannot be closed as if it were idle without explicit force", async (t) => {
  const h = harness(t, (method) => {
    if (method === "turn/start") throw Object.assign(Error("lost"), { code: "RPC_TIMEOUT" });
  });
  await h.executor.createOwnedSession(params);
  await assert.rejects(
    h.executor.continueOwned({ threadId: "owned1", requestId: "r1", text: "first", beforeMutation: guard }),
  );
  await assert.rejects(h.executor.close(), { code: "MANAGED_ACTIVE_TURNS" });
});

test("waitForTurn returns final answer and cumulative native usage without persisting answer text", async (t) => {
  const h = harness(t);
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({ threadId: "owned1", requestId: "r1", text: "inspect", beforeMutation: guard });
  const waiting = h.executor.waitForTurn({ threadId: "owned1", turnId: "turn1", timeoutMs: 500 });
  h.notify("item/completed", {
    threadId: "owned1",
    turnId: "turn1",
    item: { type: "agentMessage", text: "PRIVATE_FINAL_REPLY" },
  });
  h.notify("thread/tokenUsage/updated", {
    threadId: "owned1",
    turnId: "turn1",
    tokenUsage: {
      total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60 },
      last: { inputTokens: 100, outputTokens: 10 },
    },
  });
  h.notify("turn/completed", { threadId: "owned1", turn: { id: "turn1", status: "completed" } });
  const final = await waiting;
  assert.equal(final.text, "PRIVATE_FINAL_REPLY");
  assert.equal(final.completionVerified, true);
  assert.deepEqual(final.sessionUsage, { input: 100, output: 10, cached: 60 });
  assert.ok(!readFileSync(h.stateFile).includes(Buffer.from("PRIVATE_FINAL_REPLY")));
});

test("waiting timeout does not resend or claim completion", async (t) => {
  const h = harness(t);
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({ threadId: "owned1", requestId: "r1", text: "inspect", beforeMutation: guard });
  await assert.rejects(h.executor.waitForTurn({ threadId: "owned1", turnId: "turn1", timeoutMs: 15 }), {
    code: "MANAGED_WAIT_TIMEOUT",
  });
  assert.equal(h.calls.filter((x) => x.method === "turn/start").length, 1);
  assert.equal((await h.executor.readOwned("owned1", { refresh: false })).state, "running");
});

test("updated usage has a new event cursor and duplicates do not double count", async (t) => {
  const h = harness(t);
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({ threadId: "owned1", requestId: "r1", text: "inspect", beforeMutation: guard });
  const event = (n) => ({
    threadId: "owned1",
    turnId: "turn1",
    tokenUsage: { total: { inputTokens: n }, last: { inputTokens: n } },
  });
  h.notify("thread/tokenUsage/updated", event(10));
  const first = h.executor.events();
  h.notify("thread/tokenUsage/updated", event(10));
  assert.equal(h.executor.events({ after: first.at(-1).seq }).length, 0);
  h.notify("thread/tokenUsage/updated", event(20));
  assert.equal(h.executor.events({ after: first.at(-1).seq })[0].data.total.inputTokens, 20);
});

test("unowned notifications cannot inject answers or completion evidence", async (t) => {
  const h = harness(t);
  await h.executor.createOwnedSession(params);
  h.notify("turn/completed", {
    threadId: "user-thread",
    turn: { id: "foreign", status: "completed", items: [{ type: "agentMessage", text: "secret" }] },
  });
  h.notify("turn/completed", { threadId: "owned1", turn: { id: "foreign", status: "completed" } });
  assert.equal(h.executor.events().length, 0);
  await assert.rejects(h.executor.waitForTurn({ threadId: "owned1", turnId: "foreign", timeoutMs: 10 }), {
    code: "MANAGED_TURN_NOT_OWNED",
  });
});

test("managed transport starts only an owned stdio host and handles fragmented responses", async () => {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit("exit", 0));
  };
  let buffer = "",
    args,
    noticed = false;
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n"),
        q = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (q.id) {
        const payload = JSON.stringify({ id: q.id, result: {} }) + "\n";
        child.stdout.write(payload.slice(0, 7));
        child.stdout.write(payload.slice(7));
      }
    }
  });
  const rpc = new ManagedCodexRpc({
    spawn(command, argv) {
      args = argv;
      return child;
    },
    onNotification(method) {
      noticed = method === "item/completed";
    },
  });
  await rpc.connect();
  assert.deepEqual(args, ["app-server", "--stdio"]);
  child.stdout.write(
    JSON.stringify({
      method: "item/completed",
      params: { threadId: "owned1", turnId: "turn1", item: { type: "agentMessage", text: "answer" } },
    }) + "\n",
  );
  assert.equal(noticed, true);
  await assert.rejects(rpc.request("thread/delete", {}), { code: "MANAGED_METHOD_DENIED" });
  await rpc.close();
});

test("fresh validated thread starts directly without read/resume projections that lack projectId", async (t) => {
  const h = harness(t, (method) => {
    if (method === "thread/read" || method === "thread/resume")
      return { thread: { id: "owned1", cwd: "/tmp/company", status: { type: "idle" } } };
  });
  await h.executor.createOwnedSession(params);
  const result = await h.executor.continueOwned({
    threadId: "owned1",
    requestId: "fresh-first",
    text: "first",
    beforeMutation: guard,
  });
  assert.equal(result.executionId, "turn1");
  assert.deepEqual(
    h.calls.map((x) => x.method),
    ["project/read", "thread/start", "turn/start"],
  );
});

test("an empty thread after executor restart is not presumed durable or recreated", async (t) => {
  const h = harness(t);
  await h.executor.createOwnedSession(params);
  await h.executor.close();
  const next = new ManagedCodexExecutor({ stateFile: h.stateFile, enabled: true, transportFactory: h.factory });
  const before = h.calls.length;
  try {
    await assert.rejects(
      next.continueOwned({ threadId: "owned1", requestId: "after-restart", text: "first", beforeMutation: guard }),
      { code: "MANAGED_EMPTY_SESSION_UNCONFIRMED" },
    );
    assert.equal(h.calls.length, before);
  } finally {
    await next.close({ force: true });
  }
});

test("fresh cached ownership must still match persistent goal/project/cwd identity", async (t) => {
  const h = harness(t);
  await h.executor.createOwnedSession(params);
  const owned = h.executor.owned("owned1");
  h.executor.putSession({ ...owned, projectId: "other-project" });
  await assert.rejects(
    h.executor.continueOwned({ threadId: "owned1", requestId: "tampered", text: "first", beforeMutation: guard }),
    { code: "MANAGED_IDENTITY_MISMATCH" },
  );
  assert.equal(
    h.calls.some((x) => x.method === "turn/start"),
    false,
  );
});

function nativeUsageEvent(h, turnId, total, last = total) {
  h.notify("thread/tokenUsage/updated", { threadId: "owned1", turnId, tokenUsage: { total, last } });
}
function completedOwnedTurn(h, turnId) {
  h.notify("turn/completed", {
    threadId: "owned1",
    turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", text: "checked" }] },
  });
}

test("fresh first turn accounts for all model requests, not just nativeUsage.last", async (t) => {
  const h = harness(t);
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({
    threadId: "owned1",
    requestId: "usage-first",
    text: "inspect",
    beforeMutation: guard,
  });
  nativeUsageEvent(h, "turn1", { inputTokens: 150, outputTokens: 15, cachedInputTokens: 100 });
  nativeUsageEvent(
    h,
    "turn1",
    { inputTokens: 350, outputTokens: 35, cachedInputTokens: 240 },
    { inputTokens: 200, outputTokens: 20, cachedInputTokens: 140 },
  );
  completedOwnedTurn(h, "turn1");
  const result = await h.executor.waitForTurn({ threadId: "owned1", turnId: "turn1", timeoutMs: 100 });
  assert.deepEqual(result.turnUsage, { input: 350, output: 35, cached: 240 });
  assert.equal(result.turnUsageStatus, "complete");
  assert.equal(h.executor.op("usage-first").usageBaseline.inputTokens, 0);
  assert.equal(h.executor.op("usage-first").usageBaselineSource, "fresh-owned-zero");
  assert.equal(result.nativeUsage.last.inputTokens, 200);
});

test("session total baseline survives executor restart and counts only the next run delta", async (t) => {
  let turn = 0;
  const h = harness(t, (method) =>
    method === "turn/start" ? { turn: { id: "turn" + ++turn, status: "inProgress" } } : undefined,
  );
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({ threadId: "owned1", requestId: "usage-run1", text: "first", beforeMutation: guard });
  nativeUsageEvent(h, "turn1", { inputTokens: 350, outputTokens: 35, cachedInputTokens: 200 });
  completedOwnedTurn(h, "turn1");
  await h.executor.close();
  const next = new ManagedCodexExecutor({ stateFile: h.stateFile, enabled: true, transportFactory: h.factory });
  try {
    await next.continueOwned({ threadId: "owned1", requestId: "usage-run2", text: "next", beforeMutation: guard });
    assert.deepEqual(next.op("usage-run2").usageBaseline, {
      inputTokens: 350,
      cachedInputTokens: 200,
      outputTokens: 35,
    });
    nativeUsageEvent(
      h,
      "turn2",
      { inputTokens: 530, outputTokens: 53, cachedInputTokens: 310 },
      { inputTokens: 90, outputTokens: 9, cachedInputTokens: 55 },
    );
    completedOwnedTurn(h, "turn2");
    const result = await next.waitForTurn({ threadId: "owned1", turnId: "turn2", timeoutMs: 100 });
    assert.deepEqual(result.turnUsage, { input: 180, output: 18, cached: 110 });
    assert.deepEqual(result.sessionUsage, { input: 530, output: 53, cached: 310 });
  } finally {
    await next.close({ force: true });
  }
});

test("prior completed turn without a total baseline reports missing usage instead of treating total as this run", async (t) => {
  let turn = 0;
  const h = harness(t, (method) =>
    method === "turn/start" ? { turn: { id: "turn" + ++turn, status: "inProgress" } } : undefined,
  );
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({
    threadId: "owned1",
    requestId: "missing-first",
    text: "first",
    beforeMutation: guard,
  });
  completedOwnedTurn(h, "turn1");
  await h.executor.continueOwned({
    threadId: "owned1",
    requestId: "missing-second",
    text: "second",
    beforeMutation: guard,
  });
  nativeUsageEvent(h, "turn2", { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 900 });
  completedOwnedTurn(h, "turn2");
  const result = await h.executor.waitForTurn({ threadId: "owned1", turnId: "turn2", timeoutMs: 100 });
  assert.equal(result.turnUsageStatus, "missing");
  assert.equal(result.turnUsage, undefined);
  assert.deepEqual(result.turnUsageMissing, ["input", "output", "cached"]);
  assert.equal(h.executor.op("missing-second").usageBaseline, null);
});

test("regressed or absent counters are omitted individually, never clamped or guessed", async (t) => {
  let turn = 0;
  const h = harness(t, (method) =>
    method === "turn/start" ? { turn: { id: "turn" + ++turn, status: "inProgress" } } : undefined,
  );
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({
    threadId: "owned1",
    requestId: "counter-first",
    text: "first",
    beforeMutation: guard,
  });
  nativeUsageEvent(h, "turn1", { inputTokens: 500, outputTokens: 50, cachedInputTokens: 400 });
  completedOwnedTurn(h, "turn1");
  await h.executor.continueOwned({
    threadId: "owned1",
    requestId: "counter-second",
    text: "second",
    beforeMutation: guard,
  });
  nativeUsageEvent(h, "turn2", { inputTokens: 450, outputTokens: 60 });
  completedOwnedTurn(h, "turn2");
  const result = await h.executor.waitForTurn({ threadId: "owned1", turnId: "turn2", timeoutMs: 100 });
  assert.deepEqual(result.turnUsage, { output: 10 });
  assert.equal(result.turnUsageStatus, "partial");
  assert.deepEqual(result.turnUsageMissing, ["input", "cached"]);
  assert.equal(result.turnUsageReasons.input, "counter-regressed");
  assert.equal(result.turnUsageReasons.cached, "current-missing");
});

test("owned refresh uses the native notLoaded view and ignores completion of another active turn", async (t) => {
  let latest = { id: "another-turn", status: "completed" };
  const h = harness(t, (method) => (method === "thread/turns/list" ? { data: [latest] } : undefined));
  await h.executor.createOwnedSession(params);
  await h.executor.continueOwned({
    threadId: "owned1",
    requestId: "read-native-view",
    text: "inspect",
    beforeMutation: guard,
  });
  const first = await h.executor.readOwned("owned1");
  assert.equal(first.activeTurnId, "turn1");
  assert.equal(first.state, "running");
  latest = { id: "turn1", status: "completed" };
  const second = await h.executor.readOwned("owned1");
  assert.equal(second.activeTurnId, null);
  assert.equal(second.lastCompletion.turnId, "turn1");
  assert.equal(second.lastCompletion.status, "completed");
  for (const call of h.calls.filter((c) => c.method === "thread/turns/list"))
    assert.deepEqual(call.input, { threadId: "owned1", itemsView: "notLoaded", limit: 1, sortDirection: "desc" });
});

test("native notLoaded cancellation preflight still rejects another active turn and moved project", async (t) => {
  for (const mismatch of ["turn", "project"]) {
    let changed = false;
    const h = harness(t, (method) => {
      if (method === "thread/read")
        return {
          thread: {
            id: "owned1",
            projectId: changed && mismatch === "project" ? "other" : "p1",
            cwd: "/tmp/company",
            status: { type: "active" },
          },
        };
      if (method === "thread/turns/list")
        return { data: [{ id: changed && mismatch === "turn" ? "other-turn" : "turn1", status: "inProgress" }] };
    });
    await h.executor.createOwnedSession(params);
    await h.executor.continueOwned({
      threadId: "owned1",
      requestId: "cancel-native-view",
      text: "inspect",
      beforeMutation: guard,
    });
    changed = true;
    await assert.rejects(h.executor.cancelOwned({ threadId: "owned1", turnId: "turn1", beforeMutation: guard }), {
      code: mismatch === "turn" ? "MANAGED_TURN_MISMATCH" : "MANAGED_IDENTITY_MISMATCH",
    });
    assert.equal(
      h.calls.some((c) => c.method === "turn/interrupt"),
      false,
    );
  }
});
