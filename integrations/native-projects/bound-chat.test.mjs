// A named native chat is a durable handoff destination, never an instruction to open or resume a thread.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectBoundChat, queueBoundChat, verifyBoundChat } from "./bound-chat.mjs";
const threadId = "10000000-0000-4000-b000-000000000001",
  root = "/bound/work",
  projectId = "demo",
  projectKey = "codex:local:demo";
function fixture(t) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "bound-chat-"));
  t.after(() => rmSync(stateDir, { force: true, recursive: true }));
  const config = {
    managedCodex: {
      enabled: true,
      stateDir,
      projectRoots: { [projectKey]: root },
      boundChats: { [projectKey]: { threadId, root, projectId } },
    },
  };
  const f = {
    thread: { id: threadId, cwd: root, projectId: null, ephemeral: false },
    listed: true,
    queue: [],
    turns: [],
    calls: [],
    failAfterWrite: false,
  };
  const client = {
    async request(m, p) {
      f.calls.push(m);
      if (m === "project/read") return { project: { id: projectId, roots: [{ path: root }] } };
      if (m === "thread/read") return { thread: f.thread };
      if (m === "thread/list") {
        assert.equal(p.archived, false);
        assert.deepEqual(p.cwd, [root]);
        return { data: f.listed ? [f.thread] : [], nextCursor: null };
      }
      if (m === "thread/queue/list") return { data: f.queue, nextCursor: null };
      if (m === "thread/turns/list") return { data: f.turns, nextCursor: null };
      if (m === "thread/queue/add") {
        const queuedSubmission = { id: "q-1", clientUserMessageId: p.clientUserMessageId, input: p.input };
        f.queue.push(queuedSubmission);
        if (f.failAfterWrite) throw Error("lost");
        return { queuedSubmission };
      }
      throw Error("Unexpected method: " + m);
    },
  };
  return Object.assign(f, {
    config,
    projectKey,
    requestId: "goal:2:work:1",
    text: "请核对项目清单，回复目前最需要确认的一项。",
    beforeMutation() {},
    client,
  });
}
test("verified unassigned exact-root chat is queued once even on replay, busy or lost acknowledgement", async (t) => {
  const f = fixture(t);
  f.thread.status = { type: "active" };
  f.failAfterWrite = true;
  assert.equal((await verifyBoundChat(f)).status, "verified");
  const accepted = await queueBoundChat(f);
  assert.equal(accepted.status, "queued");
  assert.equal((await queueBoundChat(f)).status, "queued");
  assert.equal(f.calls.filter((m) => m === "thread/queue/add").length, 1);
  assert.ok(!f.calls.some((m) => ["thread/start", "thread/resume", "thread/queue/start", "turn/start"].includes(m)));
  f.queue = [];
  assert.equal((await queueBoundChat(f)).status, "unknown");
  assert.equal(f.calls.filter((m) => m === "thread/queue/add").length, 1);
  assert.equal((await queueBoundChat({ ...f, text: "完全不同的动作" })).status, "unknown");
});
test("reject missing source, stale binding, archive and missing guard before any write", async (t) => {
  const f = fixture(t);
  f.listed = false;
  assert.equal((await queueBoundChat(f)).status, "missing");
  f.listed = true;
  f.thread.cwd = "/elsewhere";
  assert.equal((await queueBoundChat(f)).status, "unknown");
  f.thread.cwd = root;
  f.thread.projectId = "another";
  assert.equal((await queueBoundChat(f)).status, "unknown");
  f.thread.projectId = projectId;
  assert.equal((await queueBoundChat({ ...f, beforeMutation: undefined })).status, "unknown");
  assert.equal(
    (
      await queueBoundChat({
        ...f,
        beforeMutation() {
          throw Error("paused");
        },
      })
    ).status,
    "unknown",
  );
  assert.equal(f.calls.filter((m) => m === "thread/queue/add").length, 0);
});
test("execution evidence requires exact client id, exact text and a final reply after the matching input in its own turn", async (t) => {
  const f = fixture(t);
  const q = await queueBoundChat(f);
  assert.equal(q.status, "queued");
  f.queue = [];
  const user = { type: "userMessage", clientId: q.clientUserMessageId, content: [{ type: "text", text: f.text }] },
    final = { id: "reply", type: "agentMessage", phase: "final_answer", text: "先核对入口。" };
  f.turns = [{ id: "turnA", status: "completed", items: [{ ...user, clientId: "not-the-handoff" }, final] }];
  assert.equal((await inspectBoundChat(f)).status, "unknown");
  f.turns = [{ id: "turnA", status: "inProgress", items: [user, final] }];
  assert.equal((await inspectBoundChat(f)).status, "in-thread");
  f.turns = [{ id: "turnA", status: "completed", items: [final, user] }];
  assert.ok(!(await inspectBoundChat(f)).reply);
  f.turns = [{ id: "turnA", status: "completed", items: [user, { ...user, clientId: "other" }, final] }];
  assert.ok(!(await inspectBoundChat(f)).reply);
  f.turns = [{ id: "turnA", status: "completed", items: [user, final] }];
  const done = await inspectBoundChat(f);
  assert.equal(done.status, "completed");
  assert.equal(done.turnId, "turnA");
  assert.equal(done.reply, final.text);
});

test("inspection before any handoff leaves no local intent database", async (t) => {
  const f = fixture(t);
  assert.equal((await inspectBoundChat(f)).status, "unknown");
  assert.equal(existsSync(path.join(f.config.managedCodex.stateDir, "bound-chat.db")), false);
});
test("adopting an existing matching native queue entry never re-enqueues a later unconfirmed delivery", async (t) => {
  const f = fixture(t);
  const q = await queueBoundChat(f);
  rmSync(path.join(f.config.managedCodex.stateDir, "bound-chat.db"));
  assert.equal((await queueBoundChat(f)).queuedSubmissionId, q.queuedSubmissionId);
  f.queue = [];
  assert.equal((await queueBoundChat(f)).status, "unknown");
  assert.equal(f.calls.filter((m) => m === "thread/queue/add").length, 1);
});
