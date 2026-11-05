// Owner-addressed project requests must have exactly one dispatch path; other messages retain legacy handling.
import test from "node:test";
import assert from "node:assert/strict";
import { routeProjectMessage } from "./feishu-route.mjs";
const cfg = {
  enabled: true,
  chatId: "oc_group",
  allowedSenderIds: ["ou_owner"],
  botMentionIds: ["ou_bot"],
  projectNames: ["Demo"],
};
const e = (content, extra = {}) => ({
  content,
  chat_id: "oc_group",
  sender_id: "ou_owner",
  sender_type: "user",
  message_type: "text",
  mentions: [{ id: "ou_bot", name: "Bot", key: "@_1" }],
  ...extra,
});
test("natural project queries reserve only verified owner mentions", () => {
  for (const content of ["Demo现在怎样了", "暂停这个项目", "能不能暂停", "你能做什么"])
    assert.equal(routeProjectMessage(e(content), cfg), "loop");
  for (const extra of [
    { sender_id: "ou_other" },
    { chat_id: "oc_other" },
    { mentions: [] },
    { mentions: [{ id: "ou_other_bot", name: "Bot" }] },
    { sender_type: "app" },
    { message_type: "post" },
  ])
    assert.equal(routeProjectMessage(e("暂停项目", extra), cfg), "legacy");
});
test("ordinary business messages and disabled routing stay on the old path", () => {
  assert.equal(routeProjectMessage(e("做一张海报"), cfg), "legacy");
  assert.equal(routeProjectMessage(e("暂停项目"), { ...cfg, enabled: false }), "legacy");
  assert.equal(routeProjectMessage(e("/loop 项目", { mentions: [] }), {}), "loop");
});
