// Discussion is not dispatch. Keep claims of current project state in the caller's scoped and verified facts.
import test from "node:test";
import assert from "node:assert/strict";
import { answerSemanticChat } from "./semantic-query.mjs";
const a = { provider: "codex", alias: "C-0123456789", name: "工作台A", root: "/private/nope" },
  b = { provider: "multica", alias: "M-9876543210", name: "内容B" };
const base = {
  command: "/test",
  view: { projects: [a, b] },
  aliases: [a.alias],
  history: [{ role: "user", text: "我比较担心试用是否够具体" }],
};
test("chat uses only approved evidence for selected projects, keeps history as dialogue, and shows real facts verbatim", async () => {
  const r = await answerSemanticChat("你觉得工作台试用还需要什么？", {
    ...base,
    evidence: [
      { alias: a.alias, text: "试用方案已提交。" },
      { alias: b.alias, text: "OTHER_PRIVATE_PROJECT" },
    ],
    run: async (input) => {
      assert.match(input.prompt, /试用方案已提交/);
      assert.match(input.prompt, /试用是否够具体/);
      assert.doesNotMatch(input.prompt, /OTHER_PRIVATE_PROJECT|内容B|\/private|C-0123456789/);
      return {
        text: JSON.stringify({ reply: "我建议先找一位没用过工具的同事，观察他能否独立完成第一步。", facts: [1] }),
      };
    },
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /试用方案已提交/);
  assert.match(r.text, /我建议先/);
});
test("ordinary dialogue need not mention projects and cannot invent execution, evidence indices or actions", async () => {
  const fill = (raw) => ({
    ...base,
    aliases: [],
    run: async ({ prompt }) => {
      assert.doesNotMatch(prompt, /工作台A|内容B/);
      return { text: JSON.stringify(raw) };
    },
  });
  const r = await answerSemanticChat(
    "今天脑子转不动了",
    fill({ reply: "那我们先挑最费心的一件事说。你最想先放下哪件？", facts: [] }),
  );
  assert.ok(r.ok);
  assert.match(r.text, /先挑/);
  for (const data of [
    { reply: "我已经帮你启动了两个任务。", facts: [] },
    { reply: "行", facts: [4] },
    { reply: "好的", facts: [], action: "start" },
    { reply: "目前有两个项目在跑。", facts: [] },
  ]) {
    const invalid = await answerSemanticChat("说说看", fill(data));
    assert.equal(invalid.ok, false);
    assert.doesNotMatch(invalid.text, /帮你启动|两个项目在跑/);
  }
});

test("an unsupported project completion claim is withheld without evidence", async () => {
  const result = await answerSemanticChat("要不要跟进工作台？", {
    ...base,
    run: async () => ({ text: '{"reply":"工作台A已经上线。","facts":[]}' }),
  });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.text, /已上线/);
});
