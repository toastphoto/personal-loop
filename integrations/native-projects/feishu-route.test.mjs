// Owner-addressed project requests must have exactly one dispatch path; other messages retain legacy handling.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { directGoalRequest } from "./feishu-direct-goal.mjs";
import { readRouting, routeProjectMessage } from "./feishu-route.mjs";
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

test("the owner can open a chat picker without naming a project; selecting a chat keeps text routing in sync", (t) => {
  assert.equal(routeProjectMessage(e("@Bot 选对话"), cfg), "loop");
  assert.equal(routeProjectMessage(e("@Bot 给我做对话训练"), cfg), "legacy");
  const dir = mkdtempSync(path.join(tmpdir(), "selection-route-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controlFile = path.join(dir, "controls.json"),
    routingFile = path.join(dir, "routing.json");
  const key = "codex:local:test",
    old = "11111111-1111-1111-1111-111111111111",
    selected = "22222222-2222-2222-2222-222222222222";
  const entry = {
    name: "工作台",
    projectKey: key,
    enabledAt: "2026-01-01T00:00:00Z",
    boundChat: { title: "旧对话", threadId: old, enabledAt: "2026-01-01T00:00:00Z" },
  };
  writeFileSync(
    routingFile,
    JSON.stringify({ ...cfg, projectNames: ["工作台"], directGoalProjects: [entry], bindingControlsFile: controlFile }),
  );
  const read = (content, time) =>
    directGoalRequest({ ...e(content), create_time: String(Date.parse(time)) }, readRouting(routingFile), content);
  const at = "2026-03-01T00:00:00Z";
  writeFileSync(
    controlFile,
    JSON.stringify({
      version: 1,
      projects: {},
      chatBindings: {
        [key]: { threadId: selected, title: "新对话", updatedAt: at, revision: 1, projectId: "test", root: dir },
      },
    }),
  );
  assert.equal(read("接着「新对话」这条原对话，把测试资料理清楚。", at)?.threadId, selected);
  assert.equal(read("接着「旧对话」这条原对话，把测试资料理清楚。", at), null);
  assert.equal(read("工作台，帮我整理测试材料。", at)?.threadId, selected);
  assert.equal(read("工作台，帮我整理测试材料。", "2026-02-01T00:00:00Z"), null);
  writeFileSync(controlFile, "{}");
  assert.equal(read("工作台，帮我整理测试材料。", at), null);
});
