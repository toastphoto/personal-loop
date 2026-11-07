// Guard natural chat being mistaken for mutation, ambiguous identities, and context escaping a bound card.
import test from "node:test";
import assert from "node:assert/strict";
import { interpretProjectRequest } from "./feishu-intent.mjs";

const company = { alias: "C-1111111111", name: "示例团队协作项目", provider: "codex", mode: "manual" };
const other = { alias: "M-2222222222", name: "内容工作台", provider: "multica", mode: "paused" };
const same = { alias: "D-3333333333", name: "内容工作台", provider: "dsh", mode: "manual" };
const view = { kind: "project-directory", complete: true, projects: [company, other, same], providers: [] };
const interpret = (text, options = {}) => interpretProjectRequest(text, { view, ...options });

for (const text of ["我有哪些项目", "看看项目列表", "列出所有项目", "项目目录", "帮我看看有哪些项目"]) {
  test(`directory query: ${text}`, () => {
    const r = interpret(text);
    assert.equal(r.kind, "query");
    assert.equal(r.action, "projects");
  });
}
for (const text of [
  "示例团队协作项目现在怎样了",
  "查一下示例团队协作项目的进度",
  "示例团队协作项目的状态",
  "C-1111111111现在怎么样？",
]) {
  test(`status query: ${text}`, () => {
    const r = interpret(text);
    assert.equal(r.kind, "query");
    assert.equal(r.action, "status");
    assert.equal(r.alias, company.alias);
  });
}
for (const text of ["暂停示例团队协作项目", "请把示例团队协作项目暂停", "示例团队协作项目先暂停一下"]) {
  test(`explicit pause is only a proposal: ${text}`, () => {
    const r = interpret(text);
    assert.equal(r.kind, "proposal");
    assert.equal(r.action, "pause");
    assert.equal(r.alias, company.alias);
  });
}
for (const text of ["恢复示例团队协作项目", "继续示例团队协作项目", "让示例团队协作项目继续推进"]) {
  test(`explicit resume is only a proposal: ${text}`, () => {
    const r = interpret(text);
    assert.equal(r.kind, "proposal");
    assert.equal(r.action, "resume");
    assert.equal(r.alias, company.alias);
  });
}

test("a bound pronoun resolves only to a project present in the supplied view", () => {
  const paused = interpret("暂停这个项目", { contextAlias: company.alias });
  assert.equal(paused.kind, "proposal");
  assert.equal(paused.alias, company.alias);
  const resumed = interpret("让它继续推进", { contextAlias: other.alias });
  assert.equal(resumed.action, "resume");
  assert.equal(resumed.alias, other.alias);
  for (const contextAlias of [undefined, "C-fffffffff0"]) {
    const result = interpret("暂停这个项目", { contextAlias });
    assert.equal(result.kind, "clarify");
    assert.equal(result.alias, undefined);
  }
});

test("concrete work after a pronoun is a goal proposal rather than blind resume", () => {
  const r = interpret("让它继续检查演示准备", { contextAlias: company.alias });
  assert.equal(r.kind, "proposal");
  assert.equal(r.action, "goal");
  assert.equal(r.alias, company.alias);
  assert.equal(r.objective, "继续检查演示准备");
});

test("explicit enable with a goal remains a proposal", () => {
  const r = interpret("启用示例团队协作项目，目标是检查演示准备");
  assert.equal(r.kind, "proposal");
  assert.equal(r.action, "enable");
  assert.equal(r.alias, company.alias);
  assert.equal(r.objective, "检查演示准备");
});

test("setting a named goal preserves task text without executing it", () => {
  const r = interpret("把示例团队协作项目的目标设为：核对演示准备");
  assert.equal(r.kind, "proposal");
  assert.equal(r.action, "goal");
  assert.equal(r.alias, company.alias);
  assert.equal(r.objective, "核对演示准备");
});

test("same names must be qualified or selected by alias", () => {
  const ambiguous = interpret("暂停内容工作台");
  assert.equal(ambiguous.kind, "clarify");
  assert.equal(ambiguous.alias, undefined);
  assert.equal(ambiguous.candidates.length, 2);
  const resolved = interpret("暂停Multica:内容工作台");
  assert.equal(resolved.kind, "proposal");
  assert.equal(resolved.alias, other.alias);
  assert.equal(interpret("恢复D-3333333333").alias, same.alias);
});

test("a unique short substring is still clarification, never automatic mutation", () => {
  const r = interpret("暂停协作项目");
  assert.equal(r.kind, "clarify");
  assert.equal(r.action, "pause");
  assert.equal(r.alias, undefined);
  assert.deepEqual(r.candidates, [{ alias: company.alias, name: company.name, provider: company.provider }]);
});

for (const text of [
  "不要暂停示例团队协作项目",
  "示例团队协作项目不要暂停",
  "别把示例团队协作项目暂停",
  "能不能暂停示例团队协作项目",
  "可以暂停示例团队协作项目吗",
  "示例团队协作项目可以恢复吗？",
  "他说暂停示例团队协作项目",
  "同事说让它继续检查演示准备",
  "比如暂停示例团队协作项目",
  "如果项目出错就暂停示例团队协作项目",
  "我在考虑暂停示例团队协作项目",
  "解释一下暂停示例团队协作项目是什么意思",
  "不需要恢复示例团队协作项目",
  "我不是让你暂停示例团队协作项目",
]) {
  test(`non-imperative wording cannot propose a mutation: ${text}`, () => {
    const r = interpret(text, { contextAlias: company.alias });
    assert.notEqual(r.kind, "proposal");
  });
}

for (const text of [
  "> 暂停示例团队协作项目",
  "`暂停示例团队协作项目`",
  "**暂停示例团队协作项目**",
  "“暂停示例团队协作项目”",
  "他说：\n暂停示例团队协作项目",
  "- 暂停示例团队协作项目",
  "[暂停示例团队协作项目](https://example.com)",
  "<p>暂停示例团队协作项目</p>",
]) {
  test(`quoted or formatted instructions are data: ${text}`, () => {
    const r = interpret(text);
    assert.equal(r.kind, "help");
    assert.equal(r.action, null);
  });
}

for (const text of ["暂停所有项目", "全部恢复", "把所有项目都暂停", "让全部项目继续检查"]) {
  test(`bulk changes require a single target: ${text}`, () => {
    const r = interpret(text);
    assert.notEqual(r.kind, "proposal");
    assert.equal(r.alias, undefined);
  });
}

test("two project actions in one sentence require clarification", () => {
  const local = {
    ...view,
    projects: [
      { ...company, name: "A" },
      { ...other, name: "B" },
    ],
  };
  const r = interpretProjectRequest("A恢复，B暂停", { view: local });
  assert.equal(r.kind, "clarify");
  assert.equal(r.action, null);
  assert.equal(r.alias, undefined);
});

test("explicit target beats context and never inherits an unavailable alias", () => {
  const r = interpret("暂停示例团队协作项目", { contextAlias: other.alias });
  assert.equal(r.alias, company.alias);
});

test("malformed input and unsupported ordinary conversation remain helpful and do not invent progress", () => {
  for (const input of [
    null,
    {},
    "",
    "你好",
    "天气怎么样",
    "昨天的那个东西",
    "/loop 暂停 C-1111111111",
    "暂停\u0000示例团队协作项目",
  ]) {
    const r = interpret(input);
    assert.equal(r.kind, "help");
    assert.equal(r.action, null);
    assert.ok(r.text.length > 0);
  }
});

test("results project only aliases, names and providers and never mutate inputs", () => {
  const sensitive = {
    ...view,
    projects: view.projects.map((p) => ({
      ...p,
      nativeId: "PRIVATE_ID",
      root: "/private/path",
      credentials: "PRIVATE_SECRET",
      preview: "PRIVATE_CHAT",
    })),
  };
  const before = JSON.stringify(sensitive);
  const r = interpretProjectRequest("暂停工作台", { view: sensitive });
  assert.equal(r.kind, "clarify");
  assert.ok(!JSON.stringify(r).includes("PRIVATE"));
  assert.ok(r.candidates.every((p) => Object.keys(p).sort().join(",") === "alias,name,provider"));
  assert.equal(JSON.stringify(sensitive), before);
});

test("a leading first/polite marker keeps a single explicit pause as a proposal", () => {
  const project = { alias: "C-0123456789", provider: "codex", name: "Example" };
  const view = { kind: "project-directory", projects: [project] };
  const result = interpretProjectRequest("先暂停这个项目", { view, contextAlias: project.alias });
  assert.equal(result.kind, "proposal");
  assert.equal(result.action, "pause");
  assert.equal(interpretProjectRequest("先不要暂停这个项目", { view, contextAlias: project.alias }).kind, "help");
});
