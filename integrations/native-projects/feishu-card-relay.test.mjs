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
