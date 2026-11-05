// Failures covered: a second transport instead of the shared bus, unverified readiness, credential spill,
// broad callback scope, unsafe queue permissions, partial frames and stopping somebody else's consumer.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CardEventSubscriber } from "./callback-consumer.mjs";

class Child extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
  }
  kill(signal) {
    this.signals.push(signal);
    setImmediate(() => this.emit("close", 0, signal));
    return true;
  }
}
const marker = "[event] ready event_key=card.action.trigger\n";
const event = (id = "event-1", more = {}) => ({
  type: "card.action.trigger",
  event_id: id,
  operator_id: "ou_owner",
  message_id: "om_card",
  chat_id: "oc_group",
  host: "im_message",
  action_tag: "button",
  action_value: '{"action":"pause","nonce":"opaque"}',
  action_name: "pause",
  form_value: "",
  option: "",
  token: "private-delayed-token",
  card_content: "private-original-card",
  ...more,
});
function fixture(t, extra = {}, dependencies = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), "card-subscriber-"));
  chmodSync(folder, 0o700);
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const child = new Child();
  const calls = [];
  const config = {
    profile: "existing-profile",
    larkCommand: "lark-cli",
    chatId: "oc_group",
    allowedSenderIds: ["ou_owner"],
    queuePath: path.join(folder, "callbacks.ndjson"),
    ...extra,
  };
  const subscriber = new CardEventSubscriber(config, {
    spawn: (...args) => {
      calls.push(args);
      return child;
    },
    readyTimeoutMs: 100,
    stopTimeoutMs: 100,
    ...dependencies,
  });
  t.after(() => subscriber.stop());
  return { folder, child, config, calls, subscriber };
}
async function start(f) {
  const pending = f.subscriber.start();
  f.child.stderr.write(marker);
  await pending;
}
const code = (expected) => (error) => error.code === expected;

test("startup uses the same-profile official consumer and waits for its exact ready marker", async (t) => {
  const f = fixture(t);
  const pending = f.subscriber.start();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].slice(0, 2), [
    "lark-cli",
    ["--profile", "existing-profile", "event", "consume", "card.action.trigger", "--as", "bot"],
  ]);
  assert.equal(f.calls[0][2].shell, false);
  assert.deepEqual(f.calls[0][2].stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(f.child.stdin.writableEnded, false);
  assert.equal(f.subscriber.status().ready, false);
  f.child.stderr.write("[event] ready event_key=im.message.receive_v1\n");
  assert.equal(f.subscriber.status().ready, false);
  f.child.stderr.write("[event] ready event_key=card.act");
  f.child.stderr.write("ion.trigger\n");
  await pending;
  assert.equal(f.subscriber.status().ready, true);
});
test("callbacks are projected to a private RelayQueue normal form without tokens or card bodies", async (t) => {
  const f = fixture(t);
  await start(f);
  f.child.stdout.write(JSON.stringify(event()) + "\n");
  const raw = readFileSync(f.config.queuePath, "utf8"),
    row = JSON.parse(raw);
  assert.equal(row.message_id, "cb_" + createHash("sha256").update("event-1").digest("hex"));
  assert.equal(row.sender_id, "ou_owner");
  assert.equal(row.sender_type, "user");
  assert.equal(row.chat_id, "oc_group");
  assert.equal(row.message_type, "card_action");
  assert.deepEqual(JSON.parse(row.content), {
    eventId: "event-1",
    cardMessageId: "om_card",
    host: "im_message",
    actionTag: "button",
    actionValue: '{"action":"pause","nonce":"opaque"}',
    actionName: "pause",
    formValue: "",
    option: "",
  });
  assert.ok(!raw.includes("private-delayed-token"));
  assert.ok(!raw.includes("private-original-card"));
  assert.ok(!raw.includes('"token"'));
  assert.ok(!raw.includes("card_content"));
  assert.equal(statSync(f.folder).mode & 0o777, 0o700);
  assert.equal(statSync(f.config.queuePath).mode & 0o777, 0o600);
  assert.equal(f.subscriber.status().accepted, 1);
});
test("wrong owners, groups, hosts, event types and IDs never enter the queue", async (t) => {
  const f = fixture(t);
  await start(f);
  for (const value of [
    event("e1", { operator_id: "ou_other" }),
    event("e2", { chat_id: "oc_other" }),
    event("e3", { host: "im_top_notice" }),
    event("e4", { type: "im.message.receive_v1" }),
    event("bad id"),
    event("e5", { message_id: "file_bad" }),
    event("e6", { action_value: { action: "pause" } }),
  ])
    f.child.stdout.write(JSON.stringify(value) + "\n");
  assert.equal(readFileSync(f.config.queuePath, "utf8"), "");
  assert.equal(f.subscriber.status().accepted, 0);
  assert.equal(f.subscriber.status().dropped, 7);
});
test("stdout before stderr readiness is retained only as sanitized bounded events", async (t) => {
  const f = fixture(t);
  const pending = f.subscriber.start();
  f.child.stdout.write(JSON.stringify(event()) + "\n");
  assert.equal(readFileSync(f.config.queuePath, "utf8"), "");
  assert.equal(f.subscriber.status().accepted, 0);
  f.child.stderr.write(marker);
  await pending;
  assert.equal(f.subscriber.status().accepted, 1);
  assert.ok(!readFileSync(f.config.queuePath, "utf8").includes("private-delayed-token"));
});
test("split UTF-8 and multiple lines become individual single-line appends", async (t) => {
  const saved = [];
  const f = fixture(t, {}, { append: (line) => saved.push(line) });
  await start(f);
  const a = Buffer.from(JSON.stringify(event("e1", { action_value: '{"label":"中文"}' })) + "\n");
  const split = a.indexOf(Buffer.from("中文")) + 1;
  f.child.stdout.write(a.subarray(0, split));
  f.child.stdout.write(Buffer.concat([a.subarray(split), Buffer.from(JSON.stringify(event("e2")) + "\n")]));
  assert.equal(saved.length, 2);
  assert.ok(saved.every((line) => line.endsWith("\n") && line.split("\n").length === 2));
  assert.equal(JSON.parse(JSON.parse(saved[0]).content).actionValue, '{"label":"中文"}');
});
test("the same event retains the same derived message identity for outer queue deduplication", async (t) => {
  const f = fixture(t);
  await start(f);
  f.child.stdout.write(JSON.stringify(event()) + "\n" + JSON.stringify(event()) + "\n");
  const rows = readFileSync(f.config.queuePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].message_id, rows[1].message_id);
});
test("existing permissive queue or parent permissions are rejected without chmod or spawning", async (t) => {
  for (const kind of ["parent", "file"]) {
    const f = fixture(t);
    if (kind === "parent") chmodSync(f.folder, 0o755);
    else writeFileSync(f.config.queuePath, "", { mode: 0o644 });
    await assert.rejects(
      f.subscriber.start(),
      code(kind === "parent" ? "CARD_QUEUE_PRIVATE_DIRECTORY_REQUIRED" : "CARD_QUEUE_PRIVATE_FILE_REQUIRED"),
    );
    assert.equal(f.calls.length, 0);
    assert.equal(
      statSync(kind === "parent" ? f.folder : f.config.queuePath).mode & 0o777,
      kind === "parent" ? 0o755 : 0o644,
    );
  }
});
test("symlink queues are refused and queue replacement or permission widening stops the owned reader", async (t) => {
  const f = fixture(t);
  const target = path.join(f.folder, "target");
  writeFileSync(target, "", { mode: 0o600 });
  symlinkSync(target, f.config.queuePath);
  await assert.rejects(f.subscriber.start(), code("CARD_QUEUE_PRIVATE_FILE_REQUIRED"));
  assert.equal(f.calls.length, 0);
  const g = fixture(t);
  await start(g);
  chmodSync(g.config.queuePath, 0o644);
  g.child.stdout.write(JSON.stringify(event()) + "\n");
  assert.equal(g.subscriber.status().ready, false);
  assert.equal(g.subscriber.status().accepted, 0);
  assert.deepEqual(g.child.signals, ["SIGTERM"]);
});
test("startup timeout terminates only the owned child and leaves readiness false", async (t) => {
  const f = fixture(t, {}, { readyTimeoutMs: 10 });
  await assert.rejects(f.subscriber.start(), code("CARD_CONSUMER_READY_TIMEOUT"));
  assert.equal(f.subscriber.status().ready, false);
  assert.deepEqual(f.child.signals, ["SIGTERM"]);
  assert.equal(f.child.stdin.writableEnded, true);
});
test("structured stderr errors do not expose raw diagnostics or secrets", async (t) => {
  const f = fixture(t);
  const pending = f.subscriber.start();
  f.child.stderr.write(
    JSON.stringify({
      ok: false,
      error: {
        type: "authorization",
        subtype: "missing_scope",
        message: "private secret",
        hint: "private recovery url",
      },
    }) + "\n",
  );
  await assert.rejects(pending, code("CARD_CONSUMER_SCOPE_REQUIRED"));
  assert.ok(!JSON.stringify(f.subscriber.status()).includes("private"));
  assert.equal(readFileSync(f.config.queuePath, "utf8"), "");
});
test("exits and normal stop clear readiness and do not invoke any bus-management command", async (t) => {
  const f = fixture(t);
  await start(f);
  f.child.emit("close", 2, null);
  assert.equal(f.subscriber.status().ready, false);
  assert.equal(f.subscriber.status().errorCode, "CARD_CONSUMER_EXIT_2");
  const g = fixture(t);
  await start(g);
  await g.subscriber.stop();
  assert.equal(g.subscriber.status().ready, false);
  assert.deepEqual(g.child.signals, ["SIGTERM"]);
  assert.equal(g.child.stdin.writableEnded, true);
  assert.equal(g.calls.length, 1);
});
test("oversized lines and failed appends fail closed without persisting raw callback content", async (t) => {
  const f = fixture(t);
  await start(f);
  f.child.stdout.write("x".repeat(1048577));
  assert.equal(f.subscriber.status().errorCode, "CARD_CONSUMER_LINE_TOO_LARGE");
  assert.equal(readFileSync(f.config.queuePath, "utf8"), "");
  const g = fixture(
    t,
    {},
    {
      append: () => {
        throw new Error("private disk information");
      },
    },
  );
  await start(g);
  g.child.stdout.write(JSON.stringify(event()) + "\n");
  assert.equal(g.subscriber.status().errorCode, "CARD_QUEUE_WRITE_FAILED");
  assert.equal(g.subscriber.status().accepted, 0);
  assert.ok(!JSON.stringify(g.subscriber.status()).includes("private"));
});
test("overlong action fields are dropped before a filesystem write", async (t) => {
  const f = fixture(t);
  await start(f);
  f.child.stdout.write(JSON.stringify(event("large", { form_value: "x".repeat(32769) })) + "\n");
  assert.equal(f.subscriber.status().accepted, 0);
  assert.equal(f.subscriber.status().dropped, 1);
  assert.equal(readFileSync(f.config.queuePath, "utf8"), "");
});

test("a completed subscriber cannot replay its historical ready result as a restart", async (t) => {
  const f = fixture(t);
  await start(f);
  await f.subscriber.stop();
  await assert.rejects(f.subscriber.start(), code("CARD_CONSUMER_NEW_INSTANCE_REQUIRED"));
  assert.equal(f.calls.length, 1);
});
test("shutdown pipe noise does not overwrite the primary startup error", async (t) => {
  const f = fixture(t);
  const pending = f.subscriber.start();
  f.child.stderr.write(
    JSON.stringify({ ok: false, error: { type: "authorization", subtype: "missing_scope" } }) + "\n",
  );
  f.child.stdin.emit("error", new Error("closed pipe private path"));
  await assert.rejects(pending, code("CARD_CONSUMER_SCOPE_REQUIRED"));
  assert.equal(f.subscriber.status().errorCode, "CARD_CONSUMER_SCOPE_REQUIRED");
});

test("successful durable append wakes the parent once without passing callback data", async (t) => {
  let notifications = 0;
  let countAtNotification = 0;
  const f = fixture(
    t,
    {},
    {
      onEvent: (...args) => {
        notifications++;
        assert.equal(args.length, 0);
        const rows = readFileSync(f.config.queuePath, "utf8").trim().split("\n").map(JSON.parse);
        countAtNotification = rows.length;
        assert.equal(rows[0].message_type, "card_action");
      },
    },
  );
  await start(f);
  f.child.stdout.write(JSON.stringify(event()) + "\n");
  assert.equal(notifications, 1);
  assert.equal(countAtNotification, 1);
  assert.equal(f.subscriber.status().accepted, 1);
});
test("filtered and unpersisted callbacks never wake the parent", async (t) => {
  let notifications = 0;
  const f = fixture(
    t,
    {},
    {
      onEvent: () => {
        notifications++;
      },
    },
  );
  await start(f);
  f.child.stdout.write(JSON.stringify(event("other-owner", { operator_id: "ou_other" })) + "\n");
  assert.equal(notifications, 0);
  const g = fixture(
    t,
    {},
    {
      append: () => {
        throw new Error("disk failed");
      },
      onEvent: () => {
        notifications++;
      },
    },
  );
  await start(g);
  g.child.stdout.write(JSON.stringify(event()) + "\n");
  assert.equal(notifications, 0);
  assert.equal(g.subscriber.status().accepted, 0);
});
test("notification failure keeps the durable event and does not append it again or stop the consumer", async (t) => {
  let calls = 0;
  const f = fixture(
    t,
    {},
    {
      onEvent: () => {
        calls++;
        throw new Error("private parent failure");
      },
    },
  );
  await start(f);
  f.child.stdout.write(JSON.stringify(event()) + "\n");
  assert.equal(calls, 1);
  assert.equal(f.subscriber.status().accepted, 1);
  assert.equal(f.subscriber.status().ready, true);
  assert.equal(f.subscriber.status().errorCode, "CARD_CONSUMER_NOTIFY_FAILED");
  assert.equal(readFileSync(f.config.queuePath, "utf8").trim().split("\n").length, 1);
  assert.ok(!JSON.stringify(f.subscriber.status()).includes("private"));
});
test("pre-ready sanitized events notify only after their readiness flush persists them", async (t) => {
  let notifications = 0;
  const f = fixture(
    t,
    {},
    {
      onEvent: () => {
        notifications++;
      },
    },
  );
  const pending = f.subscriber.start();
  f.child.stdout.write(JSON.stringify(event()) + "\n");
  assert.equal(notifications, 0);
  f.child.stderr.write(marker);
  await pending;
  assert.equal(notifications, 1);
  assert.equal(f.subscriber.status().accepted, 1);
});
