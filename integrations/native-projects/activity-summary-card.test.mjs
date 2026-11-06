// Phone readers should see a decision or an outcome without scrolling past evidence or opaque conversation IDs.
import test from "node:test";
import assert from "node:assert/strict";
import { renderProjectCard } from "./feishu-project-card.mjs";

const alias = "C-0000000001";
function card(reply, extra = {}) {
  const work = { nativeId: "opaque-record-abcdef", title: "", updatedAt: "2026-08-12T10:20:00Z" };
  const activity = {
    status: "available",
    complete: true,
    works: [
      work,
      { ...work, nativeId: "opaque-record-fedcba", updatedAt: null },
      { ...work, nativeId: "other", title: "销售演示" },
    ],
    selected: { ...work, latestReply: { text: reply, phase: "final_answer" }, ...extra },
  };
  return renderProjectCard(
    { kind: "project-status", project: { provider: "codex", name: "示例", alias, activity } },
    {},
    { sessionId: "valid-session", revision: 1, interactive: true },
  );
}
function visible(node) {
  if (!node || typeof node !== "object") return "";
  if (node.tag === "collapsible_panel" && !node.expanded) return node.header.title.content;
  if (typeof node.content === "string") return node.content;
  return Object.values(node).map(visible).join(" ");
}
test("a matched short report shows the pending decision while long evidence is opt-in", () => {
  const raw =
    "已完成《试点准备清单》核对。\n\n|项目|已确定|下一步|\n|---|---|---|\n|测试|待审核|补证据|\n证据：docs/plans/test.md\n```agent-autoloop\n{ }";
  const view = card(raw, { resultSummary: "两轮核对已完成。目前先规划试点。试用负责人和上线标准待确认。" });
  const top = visible(view);
  assert.match(top, /先规划试点/);
  assert.match(top, /负责人和上线标准待确认/);
  assert.doesNotMatch(top, /docs|test\.md|agent-autoloop|未命名|abcdef|任务 1|销售演示/);
  assert.match(JSON.stringify(view), /销售演示/);
});
test("without a group report extract actual status from a structured reply and keep the source private by default", () => {
  const view = card(
    "已完成《试点核对表》，三份文件哈希一致。\n\n下表列出证据:\n- **G**：`secret.md`\n| 核对项 | 已确定 | 待确认 |\n|---|---|---|\n| 项目状态 | 仍在准备试点 | 负责人 |\n| 界面 | 两个草案尚待选择 | 配色 |",
  );
  assert.match(visible(view), /仍在准备试点/);
  assert.match(visible(view), /尚待选择/);
  assert.doesNotMatch(visible(view), /哈希|secret|\|/);
});
test("a technical-only reply and old card titles never expose raw receipts or invented work in the summary", () => {
  const view = card("```agent-autoloop\n{ what:'automated' }\n```\n- G: `some/private/file.md`");
  assert.doesNotMatch(visible(view), /automated|private|未命名|核对完成/);
  const buttons = JSON.stringify(view);
  assert.doesNotMatch(buttons, /未命名会话 ·/);
  assert.match(buttons, /activity-work/);
});

test("a concise delivered summary preserves a second sentence that specifies what to do next", () => {
  const text = "材料还在准备。开工前先确定谁来验收。";
  assert.match(visible(card("已完成文件比对。", { resultSummary: text })), /材料还在准备。开工前先确定谁来验收。/);
});

test("a worker handoff leads with its human conclusion even when later evidence lists other statuses", () => {
  const brief = "两种试用方案已备好。推荐先让一位同事试用，能最快发现操作障碍。";
  const v = card("项目简报：" + brief + "\n目前还有五十行核对明细。\n|事项|已确定|\n|---|---|\n|操作|全部核实|");
  assert.ok(visible(v).includes(brief));
  assert.ok(!visible(v).includes("五十行"));
  assert.ok(JSON.stringify(v).includes("五十行"));
});

test("a coordinator record displays its reported progress, never the internal routing JSON", () => {
  const raw = JSON.stringify({
    action: "ask",
    progress: "现有试点只涉及两人。",
    question: "先测试哪个环节？",
    options: ["录入", "交付"],
    recommend: 0,
    reason: "先确定输入格式。",
    nextStep: "整理流程",
    expectedResult: "核对表",
  });
  assert.match(visible(card(raw)), /现有试点只涉及两人/);
  assert.doesNotMatch(visible(card(raw)), /expectedResult|recommend|需要你决定/);
  assert.match(
    visible(card(JSON.stringify({ action: "deliver", summary: "试用清单已整理。", deliverable: "供员工试用。" }))),
    /试用清单已整理/,
  );
});
