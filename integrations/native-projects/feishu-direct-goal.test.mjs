// An explicit owner handoff is executable only for the named, opted-in project, after opt-in.
import test from "node:test";
import assert from "node:assert/strict";
import { directGoalRequest } from "./feishu-direct-goal.mjs";

const allowed = { name: "示例工作台", projectKey: "codex:local:demo", enabledAt: "2026-01-01T00:00:00Z" };
const routing = {
  enabled: true,
  chatId: "oc_group",
  allowedSenderIds: ["ou_owner"],
  botMentionIds: ["ou_bot"],
  projectNames: ["示例工作台", "另一个工作台"],
  directGoalProjects: [allowed],
};
const event = {
  create_time: "1793934661118",
  chat_id: "oc_group",
  sender_type: "user",
  message_type: "text",
  sender_id: "ou_owner",
  mentions: [{ id: "ou_bot" }],
};
const parse = (text, ev = event, cfg = routing) => directGoalRequest(ev, cfg, text);
for (const [text, objective] of [
  ["示例工作台，帮我准备一份小组试用方案。", "准备一份小组试用方案。"],
  ["帮示例工作台准备一份小组试用方案。", "准备一份小组试用方案。"],
  ["示例工作台，我的目标是下周让三位员工试用工作台", "下周让三位员工试用工作台"],
  ["示例工作台，目标：一份可给同事试用的操作清单", "一份可给同事试用的操作清单"],
  ["请给「示例工作台」整理第一次试用清单", "整理第一次试用清单"],
  ["示例工作台的目标是让两位同事能独立完成首次试用", "让两位同事能独立完成首次试用"],
  [
    "示例工作台，帮我准备小组试用方案。到分岔处让我选方向，选完再给我验收清单。",
    "准备小组试用方案。到分岔处让我选方向，选完再给我验收清单。",
  ],
]) {
  test("owner handoff: " + text, () =>
    assert.deepEqual(parse(text), { projectKey: allowed.projectKey, name: allowed.name, objective }),
  );
}
test("casual and unsafe statements cannot enter the direct dispatch path", () => {
  for (const text of [
    "示例工作台的进度如何",
    "看看示例工作台",
    "示例工作台，帮我准备小组试用方案吗？",
    "如果给示例工作台准备小组试用方案",
    "“帮示例工作台准备试用方案”",
    "同事说帮示例工作台准备试用方案",
    "示例工作台，帮我准备小组试用方案，但先不用启动",
    "示例工作台，整理另一个工作台的资料",
    "示例工作台，准备一下",
    "示例工作台，准备演示材料这件事先搁置",
    "示例工作台，先把目标设为完成验收",
    "示例工作台，帮我准备下周试点，可以吗。",
    "示例工作台，帮我准备演示，只是先存个草稿",
    "示例工作台，准备演示方案；暂停这个项目",
    "示例，准备演示方案",
    "这个项目，准备演示方案",
    "给另一个工作台准备试用方案",
    "示例工作台，目标是随便看看",
    "示例工作台，整理",
  ]) {
    assert.equal(parse(text), null, text);
  }
});
test("a longer project name beginning with the selected name does not accidentally dispatch", () => {
  assert.equal(
    parse("帮示例工作台设计组准备试用清单", event, { ...routing, projectNames: ["示例工作台", "示例工作台设计组"] }),
    null,
  );
});
test("the authenticated mention and message creation time must be in the authorized scope", () => {
  for (const patch of [
    { mentions: [] },
    { mentions: [{ id: "ou_other" }] },
    { mentions: [{ id: "ou_bot" }, { id: "ou_other" }] },
    { chat_id: "oc_other" },
    { sender_id: "ou_other" },
    { sender_type: "app" },
    { message_type: "post" },
    { create_time: "1" },
    { create_time: undefined },
  ]) {
    assert.equal(parse("示例工作台，整理第一次试用清单", { ...event, ...patch }), null);
  }
  for (const opts of [
    { enabled: false },
    { directGoalProjects: [] },
    { directGoalProjects: [{ ...allowed, enabledAt: "invalid" }] },
  ]) {
    assert.equal(parse("示例工作台，整理第一次试用清单", event, { ...routing, ...opts }), null);
  }
});

test("an exact fresh bound chat can receive an actual instruction without being confused with quoted or ambiguous material", () => {
  const chat = {
    title: "设计示例培训",
    threadId: "22222222-2222-4222-8222-222222222222",
    enabledAt: "2026-09-01T00:00:00Z",
  };
  const r = { ...routing, directGoalProjects: [{ ...allowed, boundChat: chat }] };
  const task =
    "把完整 App 的导航和每个入口进来能做的第一件事理清楚。需要我拍板时给我选项和推荐理由，我点完接着做，别再开新对话。";
  const cmd = "接着「设计示例培训」这条原对话，" + task;
  assert.deepEqual(parse(cmd, event, r), {
    projectKey: allowed.projectKey,
    name: allowed.name,
    objective: task,
    chatTitle: chat.title,
    threadId: chat.threadId,
  });
  assert.equal(parse(cmd, { ...event, create_time: "1767302400000" }, r), null);
  assert.equal(
    parse(cmd, event, {
      ...r,
      directGoalProjects: [
        ...r.directGoalProjects,
        {
          ...allowed,
          name: "第二项目",
          projectKey: "codex:local:b",
          boundChat: { ...chat, threadId: "33333333-3333-4333-8333-333333333333" },
        },
      ],
    }),
    null,
  );
  for (const s of [
    "接着「设计示例」这条原对话，" + task,
    "接着「设计示例培训」这条原对话，进展如何",
    "请解释一下：" + cmd,
    "“" + cmd + "”",
    "接着「设计示例培训」这条原对话，" + task + "只是转述",
    "接着「设计示例培训」这条原对话，先别执行",
    "接着「设计示例培训」这条原对话，把另一个工作台的资料理清楚",
  ])
    assert.equal(parse(s, event, r), null, s);
});

test("an explicit trailing conversation reference must agree with the selected project's current binding", () => {
  const title = "设计示例培训",
    threadId = "22222222-2222-4222-8222-222222222222",
    chat = { title, threadId, enabledAt: allowed.enabledAt };
  const cfg = { ...routing, directGoalProjects: [{ ...allowed, boundChat: chat }] };
  const ask = (target) =>
    "示例工作台，帮我梳理导航，接着「" + target + "」这条原对话做。需要我拍板时给选项和推荐理由。";
  assert.equal(parse(ask(title), event, cfg)?.threadId, threadId);
  assert.equal(parse(ask("另外一个"), event, cfg), null);
  assert.equal(parse("示例工作台，整理导航，在「另外一个」这条原对话做。", event, cfg), null);
  assert.equal(parse(ask(title), event, routing), null);
});
