// Owner speech is input data, never authority. Accept only a bounded, source-backed, read-only query plan.
import test from "node:test";
import assert from "node:assert/strict";
import { interpretSemanticQuery } from "./semantic-query.mjs";

const cd = { name: "内部提效", provider: "codex", alias: "C-0000000001" };
const a = { name: "内容工作台", provider: "codex", alias: "C-0000000002" };
const b = { name: "内容工作台", provider: "multica", alias: "M-0000000003" };
const view = {
  kind: "project-directory",
  projects: [{ ...cd, root: "/private/safe-secret", objective: "never forward this goal" }, a, b],
};
const opts = (reply, extra = {}) => ({
  view,
  command: "/fixture/codex",
  run: async () => ({ text: JSON.stringify(reply) }),
  ...extra,
});

test("asking about active work yields a read plan, no invented project name or native data in the prompt", async () => {
  const r = await interpretSemanticQuery(
    "看一下我有哪些项目在跑",
    opts(null, {
      contextAlias: cd.alias,
      run: async (input) => {
        assert.match(input.prompt, /看一下我有哪些项目在跑/);
        assert.match(input.prompt, /内部提效/);
        assert.doesNotMatch(input.prompt, /safe-secret|never forward|C-0000000001/);
        return { text: '{"intent":"portfolio","filter":"running"}' };
      },
    }),
  );
  assert.deepEqual(r, { kind: "query", action: "portfolio", filter: "running" });
});
test("a semantic project candidate maps to a trusted alias and duplicate titles clarify unless source is explicit", async () => {
  assert.deepEqual(await interpretSemanticQuery("提效那个忙到哪儿了", opts({ intent: "status", projects: [1] })), {
    kind: "query",
    action: "status",
    alias: cd.alias,
  });
  const ambiguous = await interpretSemanticQuery("内容工作台进展呢", opts({ intent: "status", projects: [2] }));
  assert.deepEqual(
    ambiguous.candidates.map((i) => i.alias),
    [a.alias, b.alias],
  );
  assert.equal(ambiguous.kind, "clarify");
  assert.deepEqual(
    await interpretSemanticQuery(
      "Multica 里那个内容工作台进展呢",
      opts({ intent: "status", projects: [3], provider: "multica" }),
    ),
    { kind: "query", action: "status", alias: b.alias },
  );
});
test("only supported protocol keys and supplied candidate indices may be returned", async () => {
  for (const payload of [
    { intent: "enable", project: 1 },
    { intent: "portfolio", filter: "running", run: "now" },
    { intent: "status", projects: [99] },
    { intent: "status", projects: [1], provider: "dsh" },
  ]) {
    const r = await interpretSemanticQuery("比如现在怎么样", opts(payload));
    assert.equal(r.kind, "unavailable");
  }
});
test("waits, choosing chats and unrelated assignments have distinct actions; no model prose reaches the group", async () => {
  assert.deepEqual(await interpretSemanticQuery("有啥卡我这里了", opts({ intent: "portfolio", filter: "waiting" })), {
    kind: "query",
    action: "portfolio",
    filter: "waiting",
  });
  assert.deepEqual(await interpretSemanticQuery("挑个聊天", opts({ intent: "pick-chat" })), {
    kind: "query",
    action: "pick-chat",
  });
  assert.deepEqual(await interpretSemanticQuery("设计一张海报", opts({ intent: "external" })), {
    kind: "external",
    action: null,
  });
  const r = await interpretSemanticQuery("做哪条来着", opts({ intent: "clarify", projects: [1, 3] }));
  assert.equal(r.kind, "clarify");
  assert.deepEqual(r.candidates, [cd, a, b]);
});
test("model timeouts, tool output and malformed data do not claim projects are missing or run business work", async () => {
  for (const run of [
    async () => {
      throw Error("PRIVATE_FAILURE");
    },
    async () => ({ text: "我已经把所有项目启动了" }),
    async () => ({ text: '{"intent":"external","do":"start"}' }),
  ]) {
    const r = await interpretSemanticQuery("我有哪些项目在跑", opts(null, { run }));
    assert.equal(r.kind, "unavailable");
    assert.doesNotMatch(r.text, /找不到|没有匹配|PRIVATE|已经启动/);
  }
});

test("only the interpretation is cached; context changes require fresh semantics and failures can recover", async () => {
  const cache = new Map();
  let n = 0,
    fail = false;
  const run = async (input) => {
    n++;
    assert.equal(input.classificationOnly, true);
    assert.equal(input.timeoutMs, 45000);
    if (fail) throw Error();
    return { text: '{"intent":"portfolio","filter":"waiting"}' };
  };
  const opt = { view, command: "/fixture", run, cache };
  const question = "手头有啥等我拿主意？";
  const first = await interpretSemanticQuery(question, opt);
  assert.equal(first.filter, "waiting");
  first.filter = "corrupted";
  assert.equal((await interpretSemanticQuery(question, opt)).filter, "waiting");
  assert.equal(n, 1);
  fail = true;
  assert.equal((await interpretSemanticQuery(question, { ...opt, contextAlias: a.alias })).kind, "unavailable");
  fail = false;
  assert.equal((await interpretSemanticQuery(question, { ...opt, contextAlias: a.alias })).kind, "query");
  assert.equal(n, 3);
});

test("a conversation can compare multiple chosen projects, preserve duplicate-name ambiguity, and respond without a project", async () => {
  const v = { projects: [cd, a, { ...b, name: "市场素材" }] };
  for (const intent of ["chat", "status"]) {
    const result = await interpretSemanticQuery(
      "内部提效跟市场素材这两件事你觉得先顾哪个？",
      opts({ intent, projects: [1, 3] }, { view: v }),
    );
    assert.deepEqual(result, { kind: "chat", action: "talk", aliases: [cd.alias, b.alias] });
  }
  const r = await interpretSemanticQuery("内容工作台哪有问题", opts({ intent: "chat", projects: [2] }));
  assert.equal(r.kind, "clarify");
  assert.deepEqual(await interpretSemanticQuery("天啦，今天太忙了", opts({ intent: "chat" })), {
    kind: "chat",
    action: "talk",
    aliases: [],
  });
});
