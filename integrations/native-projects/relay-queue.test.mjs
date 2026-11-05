// Prevent command loss on partial writes/restarts, duplicate mutation, and redoing work after reply failure.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RelayQueue } from "./relay-queue.mjs";

const event = (id, content = "/loop 项目", extra = {}) => ({
  message_id: id,
  sender_id: "sender-one",
  chat_id: "chat-one",
  message_type: "text",
  content,
  ...extra,
});
const line = (value) => JSON.stringify(value) + "\n";
const filter = (value) => typeof value?.content === "string" && value.content.startsWith("/loop ");
function setup(t, initial = "") {
  const folder = mkdtempSync(path.join(tmpdir(), "relay-queue-"));
  const file = path.join(folder, "queue.ndjson");
  const dbFile = path.join(folder, "relay.db");
  writeFileSync(file, initial);
  let now = 1000;
  const queue = new RelayQueue(dbFile, { now: () => now });
  t.after(() => {
    queue.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return {
    folder,
    file,
    dbFile,
    queue,
    tick: (value) => {
      now += value;
    },
  };
}

test("startup requires an explicit offset and tail never replays old commands", (t) => {
  const { file, queue } = setup(t, line(event("old")));
  assert.throws(() => queue.ingest(file, { filter }), /INITIAL_OFFSET_REQUIRED/);
  queue.ingest(file, { initialOffset: "tail", filter });
  assert.deepEqual(queue.pending(), []);
  appendFileSync(file, line(event("new")));
  assert.equal(queue.ingest(file, { filter }).inserted, 1);
  assert.equal(queue.pending()[0].id, "new");
});

test("complete UTF-8 records advance exact byte offsets while partial records wait", (t) => {
  const first = line(event("one", "/loop 启用 C-test | 一个明确目标"));
  const second = Buffer.from(line(event("two", "/loop 暂停 C-test")));
  const cut = second.indexOf(Buffer.from("暂停")) + 1;
  const { file, queue } = setup(t, Buffer.concat([Buffer.from(first), second.subarray(0, cut)]));
  queue.ingest(file, { initialOffset: 0, filter });
  assert.equal(queue.cursor(file).offset, Buffer.byteLength(first));
  assert.deepEqual(
    queue.pending().map((x) => x.id),
    ["one"],
  );
  appendFileSync(file, second.subarray(cut));
  queue.ingest(file, { filter });
  assert.equal(queue.cursor(file).offset, statSync(file).size);
  assert.deepEqual(
    queue.pending().map((x) => x.id),
    ["one", "two"],
  );
});

test("tail inside an old incomplete record discards only its continuation", (t) => {
  const old = line(event("old"));
  const { file, queue } = setup(t, old.slice(0, 20));
  queue.ingest(file, { initialOffset: "tail", filter });
  appendFileSync(file, old.slice(20) + line(event("new")));
  queue.ingest(file, { filter });
  assert.deepEqual(
    queue.pending().map((x) => x.id),
    ["new"],
  );
});

test("filtered messages are not stored and duplicate delivery keeps one command", (t) => {
  const { file, queue } = setup(
    t,
    line(event("normal", "ordinary private chat")) +
      line(event("one")) +
      line(event("one", "/loop 项目", { event_id: "another-delivery", timestamp: "later" })),
  );
  const report = queue.ingest(file, { initialOffset: 0, filter });
  assert.equal(report.inserted, 1);
  assert.equal(report.duplicates, 1);
  assert.equal(queue.get("normal"), null);
  assert.equal(queue.pending().length, 1);
  assert.ok(!JSON.stringify(queue.pending()).includes("ordinary private chat"));
});

test("same message with another sender is rejected without moving the checkpoint", (t) => {
  const { file, queue } = setup(t, line(event("one")));
  queue.ingest(file, { initialOffset: 0, filter });
  const offset = queue.cursor(file).offset;
  appendFileSync(file, line(event("one", "/loop 项目", { sender_id: "different-sender" })));
  assert.throws(() => queue.ingest(file, { filter }), /MESSAGE_ID_CONFLICT/);
  assert.equal(queue.cursor(file).offset, offset);
  assert.equal(queue.pending()[0].event.sender_id, "sender-one");
});

test("an ingest batch and its cursor roll back together when a later event conflicts", (t) => {
  const { file, queue } = setup(t, line(event("one")) + line(event("one", "/loop 项目", { chat_id: "other-chat" })));
  assert.throws(() => queue.ingest(file, { initialOffset: 0, filter }), /MESSAGE_ID_CONFLICT/);
  assert.equal(queue.cursor(file), null);
  assert.equal(queue.pending().length, 0);
});

test("invalid complete JSON and UTF-8 are visible failures, never silently skipped", (t) => {
  const { file, queue } = setup(t, "{broken}\n");
  assert.throws(() => queue.ingest(file, { initialOffset: 0, filter }), /INVALID_NDJSON/);
  assert.equal(queue.cursor(file), null);
  writeFileSync(file, Buffer.from([0xff, 0x0a]));
  assert.throws(() => queue.ingest(file, { initialOffset: 0, filter }), /INVALID_UTF8/);
});

test("inode rotation, truncation, and truncate-regrow are rejected explicitly", (t) => {
  const { file, folder, queue } = setup(t, line(event("one")));
  queue.ingest(file, { initialOffset: 0, filter });
  const cursor = queue.cursor(file);
  writeFileSync(file, "");
  assert.throws(() => queue.ingest(file, { filter }), /QUEUE_CHANGED/);
  writeFileSync(file, line(event("other-with-a-longer-id")));
  assert.throws(() => queue.ingest(file, { filter }), /QUEUE_CHANGED/);
  renameSync(file, path.join(folder, "queue.ndjson.1"));
  writeFileSync(file, line(event("one")));
  assert.throws(() => queue.ingest(file, { filter }), /QUEUE_CHANGED/);
  assert.equal(queue.cursor(file).offset, cursor.offset);
});

test("saved handling result survives restart and replies retry without redoing the command", (t) => {
  const { file, dbFile, queue } = setup(t, line(event("one")));
  queue.ingest(file, { initialOffset: 0, filter });
  const requestId = queue.pending()[0].requestId;
  queue.saveResult("one", { mode: "paused", revision: 2 }, "已经暂停");
  queue.markFailure("one", "reply", "NETWORK_DOWN", { retryAfterMs: 0 });
  const deliveryKey = queue.pendingReplies()[0].deliveryKey;
  assert.equal(queue.pending().length, 0);
  queue.close();
  const resumed = new RelayQueue(dbFile);
  t.after(() => resumed.close());
  assert.equal(resumed.pending().length, 0);
  assert.equal(resumed.pendingReplies()[0].requestId, requestId);
  assert.equal(resumed.pendingReplies()[0].deliveryKey, deliveryKey);
  resumed.markReply("one", "reply-one");
  resumed.markReply("one", "reply-one");
  assert.equal(resumed.pendingReplies().length, 0);
  assert.equal(resumed.get("one").state, "replied");
  assert.throws(() => resumed.markReply("one", "other-reply"), /DELIVERY_REF_CONFLICT/);
});

test("handler failure keeps stable request identity and waits until retry time", (t) => {
  const { file, queue, tick } = setup(t, line(event("one")));
  queue.ingest(file, { initialOffset: 0, filter });
  const requestId = queue.pending()[0].requestId;
  queue.markFailure("one", "handling", "TEMPORARY", { retryAfterMs: 500 });
  assert.equal(queue.pending().length, 0);
  tick(500);
  assert.equal(queue.pending()[0].requestId, requestId);
  assert.equal(queue.pending()[0].handlingAttempts, 1);
});

test("a saved result is immutable and a reply cannot precede handling", (t) => {
  const { file, queue } = setup(t, line(event("one")));
  queue.ingest(file, { initialOffset: 0, filter });
  assert.throws(() => queue.markReply("one", "reply"), /RESULT_NOT_SAVED/);
  queue.saveResult("one", { mode: "paused" }, "paused");
  queue.saveResult("one", { mode: "paused" }, "paused");
  assert.throws(() => queue.saveResult("one", { mode: "active" }, "active"), /RESULT_ALREADY_SAVED/);
  assert.throws(() => queue.markFailure("one", "handling", "RETRY"), /RESULT_ALREADY_SAVED/);
});

test("only one queue owner can mutate the journal and close releases ownership", (t) => {
  const { dbFile, queue } = setup(t);
  assert.throws(() => new RelayQueue(dbFile), /RELAY_QUEUE_BUSY/);
  queue.close();
  const next = new RelayQueue(dbFile);
  next.close();
  assert.equal(statSync(dbFile).mode & 0o777, 0o600);
});

test("an asynchronous filter is refused, not treated as a truthy authorization", (t) => {
  const { file, queue } = setup(t, line(event("one")));
  assert.throws(
    () => queue.ingest(file, { initialOffset: 0, filter: async () => false }),
    /FILTER_MUST_BE_SYNCHRONOUS/,
  );
  assert.equal(queue.pending().length, 0);
});

test("a rewrite during filtering cannot advance past unseen replacement bytes", (t) => {
  const { file, queue } = setup(t, line(event("original")));
  assert.throws(
    () =>
      queue.ingest(file, {
        initialOffset: 0,
        filter: (value) => {
          writeFileSync(file, line(event("replacement-with-a-longer-id")));
          return true;
        },
      }),
    /QUEUE_CHANGED/,
  );
  assert.equal(queue.pending().length, 0);
  assert.equal(queue.cursor(file), null);
});

test("exhausted replies become terminal and cannot starve later replies", (t) => {
  const messages = Array.from({ length: 11 }, (_, index) => event(`message-${index + 1}`));
  const { file, queue } = setup(t, messages.map(line).join(""));
  queue.ingest(file, { initialOffset: 0, filter });
  for (const message of messages) queue.saveResult(message.message_id, { ok: true }, "Result");
  for (const message of messages.slice(0, 10)) {
    for (let attempt = 0; attempt < 3; attempt++)
      queue.markFailure(message.message_id, "reply", "NETWORK_DOWN", { retryAfterMs: 0 });
  }
  const exhausted = queue.pendingReplies({ limit: 10 });
  assert.equal(exhausted.length, 10);
  assert.ok(exhausted.every((item) => item.replyAttempts === 3));
  for (const item of exhausted) {
    queue.markReplyAbandoned(item.id, "REPLY_RETRIES_EXHAUSTED");
    queue.markReplyAbandoned(item.id, "REPLY_RETRIES_EXHAUSTED");
  }
  assert.deepEqual(
    queue.pendingReplies({ limit: 10 }).map((item) => item.id),
    ["message-11"],
  );
  assert.equal(queue.stats().reply_failed, 10);
  assert.equal(queue.get("message-1").deliveryRef, null);
  assert.equal(queue.pending().length, 0);
  assert.throws(() => queue.markReply("message-1", "not-really-sent"), /REPLY_NOT_PENDING/);
});

test("discard after revoked authorization removes pending work and replies without faking delivery", (t) => {
  const { file, dbFile, queue } = setup(t, line(event("pending")) + line(event("handled")) + line(event("abandoned")));
  queue.ingest(file, { initialOffset: 0, filter });
  queue.saveResult("handled", { mode: "paused" }, "Paused");
  queue.saveResult("abandoned", { mode: "manual" }, "Manual");
  queue.markReplyAbandoned("abandoned", "RETRY_EXHAUSTED");
  for (const id of ["pending", "handled", "abandoned"]) {
    const discarded = queue.discard(id, "AUTHORIZATION_REVOKED");
    assert.equal(discarded.state, "ignored");
    assert.equal(discarded.deliveryRef, null);
    queue.discard(id, "AUTHORIZATION_REVOKED");
  }
  assert.equal(queue.pending().length, 0);
  assert.equal(queue.pendingReplies().length, 0);
  assert.equal(queue.get("handled").result.mode, "paused");
  assert.throws(() => queue.markReply("handled", "not-sent"), /REPLY_NOT_PENDING/);
  queue.close();
  const reopened = new RelayQueue(dbFile);
  t.after(() => reopened.close());
  assert.equal(reopened.pendingReplies().length, 0);
  assert.equal(reopened.stats().ignored, 3);
});

test("delivery terminal APIs do not erase an actual delivery", (t) => {
  const { file, queue } = setup(t, line(event("one")));
  queue.ingest(file, { initialOffset: 0, filter });
  assert.throws(() => queue.markReplyAbandoned("one", "FAIL"), /RESULT_NOT_SAVED/);
  queue.saveResult("one", { ok: true }, "Sent result");
  queue.markReply("one", "actual-delivery");
  assert.throws(() => queue.discard("one", "AUTHORIZATION_REVOKED"), /ALREADY_REPLIED/);
  assert.throws(() => queue.markReplyAbandoned("one", "FAIL"), /ALREADY_REPLIED/);
  assert.equal(queue.get("one").deliveryRef, "actual-delivery");
});

test("reply idempotency keys fit the platform limit even for a long message ID", (t) => {
  const { file, queue } = setup(t, line(event("message-" + "x".repeat(400))));
  queue.ingest(file, { initialOffset: 0, filter });
  const key = queue.pending()[0].deliveryKey;
  assert.match(key, /^plr-[0-9a-f]{40}$/);
  assert.ok(key.length <= 50);
});
