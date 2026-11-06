// Card updates must target the bound original message, never resend controls or regress a newer card revision.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { RelayQueue } from "./relay-queue.mjs";
import { FeishuCardRelay, patchProjectCard } from "./feishu-card-relay.mjs";
const config = { profile: "bot", chatId: "oc_group", allowedSenderIds: ["ou_owner"] };
const response = {
  type: "interactive",
  sessionId: "s",
  revision: 1,
  messageId: "om_card",
  card: { schema: "2.0", body: { elements: [] } },
};
test("patch fixes bot identity and exact message and accepts an empty successful API data body", async () => {
  let call;
  assert.equal(
    await patchProjectCard(config, response, async (program, args, options) => {
      call = { args, options };
      return { exitCode: 0, stdout: '{"ok":true,"data":{}}' };
    }),
    "om_card",
  );
  assert.ok(call.args.includes("patch"));
  assert.ok(call.args.includes("om_card"));
  assert.deepEqual(call.args.slice(-4), ["--as", "bot", "--data", "-"]);
  assert.deepEqual(JSON.parse(call.options.input), { content: JSON.stringify(response.card) });
  await assert.rejects(
    patchProjectCard(config, response, async () => ({ exitCode: 0, stdout: "{}" })),
    { code: "CARD_PATCH_UNCONFIRMED" },
  );
});
test("callback retry uses saved output once and an old pending patch never regresses the card", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-relay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, "events.ndjson");
  writeFileSync(queuePath, "");
  const queue = new RelayQueue(path.join(dir, "queue.db"), { now: () => Date.now() + 10000 });
  t.after(() => queue.close());
  let handled = 0,
    patches = 0,
    current = true;
  const controller = {
    handle: async () => {
      handled++;
      return response;
    },
    current: () => current,
  };
  const relay = new FeishuCardRelay(
    { ...config, queuePath },
    {
      queue,
      controller,
      execute: async () => {
        patches++;
        return { exitCode: 1, stdout: "" };
      },
    },
  );
  const event = {
    message_id: "cb_e",
    sender_id: "ou_owner",
    sender_type: "user",
    chat_id: "oc_group",
    message_type: "card_action",
    content: JSON.stringify({ eventId: "e", cardMessageId: "om_card" }),
  };
  appendFileSync(queuePath, JSON.stringify(event) + "\n");
  await relay.tick();
  assert.equal(handled, 1);
  assert.equal(patches, 1);
  current = false;
  queue.db.prepare("UPDATE relay_messages SET reply_retry_at=0").run();
  await relay.tick();
  assert.equal(handled, 1);
  assert.equal(patches, 1);
  assert.equal(queue.get("cb_e").state, "replied");
  assert.equal(queue.get("cb_e").deliveryRef, "superseded");
});
test("owner decision clicks reach the hub once with actual message binding, separate from directory navigation", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "decision-relay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, "events.ndjson");
  const queue = new RelayQueue(path.join(dir, "queue.db"));
  t.after(() => queue.close());
  const args = [];
  const relay = new FeishuCardRelay(
    { ...config, queuePath },
    {
      queue,
      controller: {
        handle() {
          throw new Error("wrong controller");
        },
      },
      execute() {
        throw new Error("hub owns the message update");
      },
      answerDecisionClick: async (a) => {
        args.push(a);
        return { ok: true };
      },
    },
  );
  const click = (id, action, sender = "ou_owner", tag = "button") =>
    JSON.stringify({
      message_id: "cb_" + id,
      sender_id: sender,
      sender_type: "user",
      chat_id: "oc_group",
      message_type: "card_action",
      content: JSON.stringify({
        eventId: id,
        cardMessageId: "om_actual",
        host: "im_message",
        actionTag: tag,
        actionValue: JSON.stringify(action),
      }),
    });
  const action = { personalLoopDecision: 1, card: 2, choice: 0, version: 1 };
  writeFileSync(
    queuePath,
    [
      click("1", action),
      click("1", action),
      click("2", action, "ou_other"),
      click("3", { ...action, choice: -1 }),
      click("4", action, "ou_owner", "checker"),
    ].join("\n") + "\n",
  );
  await relay.tick();
  await relay.tick();
  assert.equal(args.length, 1);
  assert.deepEqual(args[0], {
    cardId: 2,
    choice: 0,
    version: 1,
    actor: "ou_owner",
    messageId: "om_actual",
    requestId: queue.get("cb_1").requestId,
    profile: "bot",
    chatId: "oc_group",
  });
  assert.equal(queue.get("cb_1").state, "replied");
  assert.equal(queue.get("cb_3").state, "ignored");
  assert.equal(queue.get("cb_4").state, "ignored");
});
