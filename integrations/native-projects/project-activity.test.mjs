// Keep one selected native scope, minimize reply data, and never turn timeouts or stale metadata into empty/live claims.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ProjectActivity } from "./project-activity.mjs";
const key = "codex:local:p1";
const iso = (n) => new Date(Date.UTC(2026, 10, 5, 0, n)).toISOString();
const work = (nativeId, more = {}) => ({
  nativeId,
  projectId: "p1",
  title: nativeId,
  state: "idle",
  nativeState: "idle",
  updatedAt: iso(1),
  membership: "native-project",
  runtimeStateTrusted: true,
  ...more,
});
function fixture({ items = [work("t1")], reply, complete = true, options = {} } = {}) {
  const calls = [];
  let currentNow = Date.UTC(2026, 10, 5, 1);
  const backend = {
    async listProjects() {
      calls.push(["projects"]);
      return { projects: [{ nativeId: "p1", provider: "codex", host: "local", name: "Project" }], complete: true };
    },
    async listWork(id) {
      calls.push(["work", id]);
      return { items, complete, observedAt: iso(5) };
    },
    async readConversation(id, params) {
      calls.push(["reply", id, params]);
      return (
        reply ?? {
          nativeId: id,
          projectId: "p1",
          complete: true,
          latestReply: {
            id: "m1",
            text: "Assistant answer",
            at: iso(4),
            phase: "final_answer",
            truncated: false,
            timeSource: "turn-completed",
          },
        }
      );
    },
  };
  const catalog = {
    host: "local",
    connectors: {
      codex: backend,
      dsh: {
        listProjects() {
          throw Error("unselected provider queried");
        },
      },
    },
    refresh() {
      throw Error("global catalogue queried");
    },
  };
  const service = new ProjectActivity(catalog, { now: () => currentNow, ...options });
  return { service, backend, catalog, calls, advance: (n) => (currentNow += n) };
}

test("only selected provider and one selected conversation are queried", async () => {
  const f = fixture({
    items: [
      work("old"),
      work("running", { state: "running", updatedAt: iso(0) }),
      work("new", { updatedAt: iso(3) }),
      work("fourth"),
    ],
  });
  const r = await f.service.read(key);
  assert.equal(r.status, "available");
  assert.equal(r.selection, "trusted-active");
  assert.equal(r.selected.nativeId, "running");
  assert.ok(r.works.length <= 3);
  assert.equal(f.calls.filter((c) => c[0] === "reply").length, 1);
  assert.deepEqual(
    f.calls.find((c) => c[0] === "reply"),
    ["reply", "running", { projectId: "p1", maxChars: 1600 }],
  );
});

test("untrusted stored running is unknown and cannot outrank trusted active work", async () => {
  const f = fixture({
    items: [
      work("stored", { state: "running", runtimeStateTrusted: false, statusSource: "stored", updatedAt: iso(9) }),
      work("live", { state: "running", updatedAt: iso(1) }),
    ],
  });
  const r = await f.service.read(key);
  assert.equal(r.selected.nativeId, "live");
  const stored = r.works.find((w) => w.nativeId === "stored");
  assert.equal(stored.state, "unknown");
  assert.equal(stored.runtimeStateTrusted, false);
  assert.equal(stored.statusSource, "stored");
});

test("native members outrank cwd associations and timestamps order within that class", async () => {
  const f = fixture({
    items: [
      work("legacy", {
        membership: "cwd-unassigned",
        updatedAt: iso(9),
        runtimeStateTrusted: false,
        statusSource: "stored",
      }),
      work("native-old", { updatedAt: iso(1) }),
      work("native-new", { updatedAt: iso(2) }),
    ],
  });
  const r = await f.service.read(key);
  assert.equal(r.selected.nativeId, "native-new");
  assert.equal(r.selection, "latest-updated");
});

test("missing timestamps never claim newest and directory associations remain explicit", async () => {
  const f = fixture({
    items: [
      work("legacy", {
        membership: "cwd-unassigned",
        updatedAt: null,
        runtimeStateTrusted: false,
        statusSource: "stored",
      }),
    ],
    reply: {
      nativeId: "legacy",
      projectId: "p1",
      complete: true,
      latestReply: { text: "answer", id: "m", at: null, phase: null, truncated: false, timeSource: "unknown" },
    },
  });
  const r = await f.service.read(key);
  assert.equal(r.selection, "order-only");
  assert.match(r.note, /时间|最新/);
  assert.match(r.note, /目录关联/);
  assert.equal(r.selected.latestReply.at, null);
});

test("explicit work selection must be in fresh scoped list and is included among at most three rows", async () => {
  const f = fixture({ items: [work("one"), work("two"), work("three"), work("chosen")] });
  const r = await f.service.read(key, { workId: "chosen" });
  assert.equal(r.selected.nativeId, "chosen");
  assert.ok(r.works.some((w) => w.nativeId === "chosen"));
  assert.ok(r.works.length <= 3);
  assert.match(r.note, /选择|选定/);
  await assert.rejects(f.service.read(key, { workId: "foreign" }), { code: "PROJECT_ACTIVITY_SCOPE_MISMATCH" });
  assert.equal(f.calls.filter((c) => c[0] === "reply").length, 1);
});

test("mismatched project host, work membership and conversation identity throw instead of returning missing data", async () => {
  const host = fixture();
  host.backend.listProjects = async () => ({ projects: [{ nativeId: "p1", host: "other" }], complete: true });
  await assert.rejects(host.service.read(key), { code: "PROJECT_ACTIVITY_SCOPE_MISMATCH" });
  const wrong = fixture({ items: [work("t1", { projectId: "other" })] });
  await assert.rejects(wrong.service.read(key), { code: "PROJECT_ACTIVITY_SCOPE_MISMATCH" });
  const conversation = fixture({ reply: { nativeId: "foreign", projectId: "p1", latestReply: null } });
  await assert.rejects(conversation.service.read(key), { code: "PROJECT_ACTIVITY_SCOPE_MISMATCH" });
});

test("scope errors invalidate cache and are not hidden behind a stale reply", async () => {
  const f = fixture();
  await f.service.read(key);
  f.advance(31000);
  f.backend.listWork = async () => ({ items: [work("t1", { projectId: "other" })], complete: true });
  await assert.rejects(f.service.read(key), { code: "PROJECT_ACTIVITY_SCOPE_MISMATCH" });
  f.backend.listWork = async () => {
    throw Error("network");
  };
  const r = await f.service.read(key);
  assert.equal(r.status, "unavailable");
  assert.equal(r.selected, null);
});

test("only allowlisted reply fields survive, text is Unicode-bounded and obvious keys are hidden", async () => {
  const secret = "sk-" + "aB3".repeat(18);
  const f = fixture({
    items: [work("t1", { root: "/private/source", credentials: "PRIVATE_CREDENTIAL", toolOutput: "PRIVATE_TOOL" })],
    reply: {
      nativeId: "t1",
      projectId: "p1",
      complete: true,
      system: "PRIVATE_SYSTEM",
      latestReply: {
        text: secret + " " + "😀".repeat(1700),
        at: iso(4),
        id: "m1",
        phase: "final_answer",
        truncated: false,
        timeSource: "turn-completed",
        tool: "PRIVATE_TOOL",
        credentials: "PRIVATE_CREDENTIAL",
        system: "PRIVATE_SYSTEM",
      },
    },
  });
  const r = await f.service.read(key);
  assert.ok([...r.selected.latestReply.text].length <= 1600);
  assert.ok(!r.selected.latestReply.text.includes(secret));
  assert.equal(r.selected.latestReply.truncated, true);
  assert.deepEqual(Object.keys(r.selected.latestReply).sort(), [
    "at",
    "id",
    "phase",
    "text",
    "timeSource",
    "truncated",
  ]);
  for (const forbidden of ["PRIVATE_SYSTEM", "PRIVATE_TOOL", "PRIVATE_CREDENTIAL", "/private/source"])
    assert.ok(!JSON.stringify(r).includes(forbidden));
});

test("a tool/system item cannot be relabelled as the assistant reply", async () => {
  for (const role of ["tool", "system"]) {
    const f = fixture({
      reply: {
        nativeId: "t1",
        projectId: "p1",
        complete: true,
        latestReply: { text: "PRIVATE_NON_REPLY", role, id: "m1", at: iso(1) },
      },
    });
    const r = await f.service.read(key);
    assert.equal(r.selected.latestReply, null);
    assert.ok(!JSON.stringify(r).includes("PRIVATE_NON_REPLY"));
  }
});

test("missing reply method reports unsupported while retaining metadata", async () => {
  const f = fixture();
  delete f.backend.readConversation;
  const r = await f.service.read(key);
  assert.equal(r.status, "available");
  assert.equal(r.complete, false);
  assert.equal(r.selected.latestReply, null);
  assert.match(r.note, /支持|接通/);
});

test("complete empty native list is empty; partial empty list is not claimed empty", async () => {
  const empty = fixture({ items: [] });
  assert.equal((await empty.service.read(key)).status, "empty");
  assert.equal(
    empty.calls.some((c) => c[0] === "reply"),
    false,
  );
  const partial = fixture({ items: [], complete: false });
  assert.equal((await partial.service.read(key)).status, "unavailable");
});

test("concurrent reads coalesce and TTL caching avoids repeated queries", async () => {
  const f = fixture();
  const original = f.backend.readConversation;
  let release;
  const waiting = new Promise((r) => (release = r));
  f.backend.readConversation = async (...args) => {
    await waiting;
    return original(...args);
  };
  const a = f.service.read(key),
    b = f.service.read(key);
  release();
  const [one, two] = await Promise.all([a, b]);
  assert.deepEqual(one, two);
  assert.equal(f.calls.filter((c) => c[0] === "projects").length, 1);
  one.selected.latestReply.text = "caller mutation";
  const cached = await f.service.read(key);
  assert.equal(cached.selected.latestReply.text, "Assistant answer");
  assert.equal(f.calls.filter((c) => c[0] === "projects").length, 1);
  f.advance(31000);
  await f.service.read(key);
  assert.equal(f.calls.filter((c) => c[0] === "projects").length, 2);
});

test("force bypasses TTL while inflight reads still coalesce", async () => {
  const f = fixture();
  await f.service.read(key);
  await f.service.read(key, { force: true });
  assert.equal(f.calls.filter((c) => c[0] === "projects").length, 2);
});

test("failed refresh returns old observedAt as stale without native error text", async () => {
  const f = fixture();
  const first = await f.service.read(key);
  f.advance(31000);
  f.backend.listProjects = async () => {
    throw Error("PRIVATE_FAILURE with credential");
  };
  const stale = await f.service.read(key);
  assert.equal(stale.status, "stale");
  assert.equal(stale.observedAt, first.observedAt);
  assert.equal(stale.complete, false);
  assert.equal(stale.selected.runtimeStateTrusted, false);
  assert.ok(!JSON.stringify(stale).includes("PRIVATE_FAILURE"));
  assert.match(stale.note, /旧|上次|过期/);
});

test("timeout reports unavailable and a late result only refreshes cache", async () => {
  const f = fixture({ options: { timeoutMs: 15 } });
  let release;
  const waiting = new Promise((r) => (release = r));
  const original = f.backend.listProjects;
  f.backend.listProjects = async () => {
    await waiting;
    return original();
  };
  const timed = await f.service.read(key);
  assert.equal(timed.status, "unavailable");
  assert.equal(timed.selected, null);
  assert.notEqual(timed.status, "empty");
  release();
  await new Promise((r) => setTimeout(r, 5));
  const later = await f.service.read(key);
  assert.equal(later.status, "available");
  assert.equal(timed.status, "unavailable");
  assert.equal(f.calls.filter((c) => c[0] === "projects").length, 1);
});

test("noncanonical keys and invalid work IDs reject before provider access", async () => {
  const f = fixture();
  for (const bad of ["codex:local:p1:extra", "codex:local:%70" + "1", "codex::p1", "codex:local:%ZZ"])
    await assert.rejects(f.service.read(bad), { code: "PROJECT_ACTIVITY_INVALID_KEY" });
  await assert.rejects(f.service.read(key, { workId: "" }), { code: "PROJECT_ACTIVITY_INVALID_WORK" });
  assert.equal(f.calls.length, 0);
});

test("private history labels never cross project or work scope, or cause extra conversation reads", async () => {
  const report = {
    replyId: "m1",
    replyAt: iso(4),
    workUpdatedAt: iso(1),
    replySha256: createHash("sha256").update("Assistant answer").digest("hex"),
    summary: "A verified earlier report",
  };
  const annotations = [
    { projectKey: key, workId: "t1", title: "Review the launch plan", report },
    { projectKey: key, workId: "t2", title: "Review the demo" },
    { projectKey: key, workId: "t3", title: "Locally named" },
    {
      projectKey: "codex:local:another",
      workId: "t1",
      title: "Private foreign title",
      report: { ...report, summary: "Private foreign summary" },
    },
  ];
  const items = [work("t1", { title: "" }), work("t2", { title: "" }), work("t3", { title: "Native author title" })];
  const f = fixture({ items, options: { historyLabels: annotations } });
  const view = await f.service.read(key, { workId: "t1" });
  assert.equal(view.selected.title, "Review the launch plan");
  assert.equal(view.selected.resultSummary, report.summary);
  assert.equal(view.works.find((x) => x.nativeId === "t2").title, "Review the demo");
  assert.equal(view.works.find((x) => x.nativeId === "t3").title, "Native author title");
  assert.equal(f.calls.filter((x) => x[0] === "reply").length, 1);
  assert.doesNotMatch(JSON.stringify(view), /Private foreign|replySha256/);

  const original = f.backend.readConversation;
  for (const patch of [
    { latestReply: { id: "new", at: iso(4), phase: "final_answer", text: "Assistant answer" } },
    { latestReply: { id: "m1", at: iso(4), phase: "final_answer", text: "Edited answer" } },
    { latestReply: { id: "m1", at: iso(6), phase: "final_answer", text: "Assistant answer" } },
    { latestReply: { id: "m1", at: iso(4), phase: "commentary", text: "Assistant answer" } },
    { updatedAt: iso(6) },
    { complete: false },
    { latestReply: null },
  ]) {
    f.backend.readConversation = async (...args) => ({ ...(await original(...args)), ...patch });
    assert.equal((await f.service.read(key, { workId: "t1", force: true })).selected.resultSummary, undefined);
  }
});
