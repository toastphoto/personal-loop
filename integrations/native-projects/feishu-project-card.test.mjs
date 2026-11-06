// Prevent mobile directories from becoming a long ID dump, inert controls, or executable project-name markup.
import test from "node:test";
import assert from "node:assert/strict";
import { renderProjectCard } from "./feishu-project-card.mjs";

const context = { sessionId: "session_test", revision: 4, interactive: true };
const project = (i, provider = "codex") => ({
  alias: `${{ codex: "C", multica: "M", dsh: "D" }[provider]}-${i.toString(16).padStart(10, "0")}`,
  name: `项目 ${i}`,
  provider,
  mode: "manual",
  revision: 0,
  execution: "read-only",
});
const view = (
  projects = Array.from({ length: 39 }, (_, i) => project(i, i < 27 ? "codex" : i < 36 ? "multica" : "dsh")),
) => ({
  kind: "project-directory",
  complete: true,
  providers: ["codex", "multica", "dsh"].map((provider) => ({ provider, status: "connected", complete: true })),
  projects,
});
function objects(value) {
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(objects)];
}
const tagged = (card, tag) => objects(card).filter((o) => o.tag === tag);
function budget(card) {
  assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 28000);
  assert.ok(objects(card).filter((o) => o.tag).length <= 180);
  assert.ok(card.body.elements.length >= 2 && card.body.elements.length <= 5);
  assert.equal(tagged(card, "hr").length, 0);
  assert.equal(objects(card).filter((o) => o.flex_mode === "stretch").length, 0);
}

test("a 39-project static directory starts with three closed sources and keeps every project reachable", () => {
  const v = view();
  const card = renderProjectCard(v, {}, { interactive: false });
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.width_mode, "default");
  assert.equal(card.header.template, "blue");
  assert.equal(card.config.enable_forward, false);
  const sources = card.body.elements.filter(
    (o) => o.tag === "collapsible_panel" && /^(Codex|Multica|DeepSeek) · /.test(o.header.title.content),
  );
  assert.equal(sources.length, 3);
  assert.ok(sources.every((s) => s.expanded === false));
  const panels = tagged(card, "collapsible_panel");
  for (const p of v.projects) {
    assert.ok(panels.some((panel) => panel.header.title.content === p.name));
    assert.ok(JSON.stringify(card).includes(`/loop 状态 ${p.alias}`));
  }
  const top = JSON.stringify(card.body.elements.filter((o) => o.tag !== "collapsible_panel"));
  assert.ok(!/[CMD]-[a-f0-9]{10}/.test(top));
  assert.equal(tagged(card, "button").length, 0);
  assert.equal(tagged(card, "select_static").length, 0);
  assert.equal(objects(card).filter((o) => o.behaviors).length, 0);
  budget(card);
});

test("manual is explained once while active and paused states remain visible in collapsed project titles", () => {
  const projects = [project(1), { ...project(2), mode: "active" }, { ...project(3), mode: "paused" }];
  const card = renderProjectCard(view(projects), {}, { interactive: false });
  const titles = tagged(card, "collapsible_panel").map((o) => o.header.title.content);
  assert.ok(titles.includes("项目 1"));
  assert.ok(titles.includes("项目 2 · 已启用"));
  assert.ok(titles.includes("项目 3 · 已暂停"));
  assert.ok(JSON.stringify(card).includes("默认仅查看"));
  budget(card);
});

test("home natively folds three sources and exposes all 40 projects without a picker or pagination", () => {
  const projects = Array.from({ length: 40 }, (_, i) => project(i, i < 28 ? "codex" : i < 37 ? "multica" : "dsh"));
  projects[0].name = projects[1].name = "同名项目";
  projects[2].mode = "active";
  projects[3].mode = "paused";
  const card = renderProjectCard(view(projects), { screen: "home" }, context);
  const sources = card.body.elements.filter(
    (o) => o.tag === "collapsible_panel" && /^(Codex|Multica|DeepSeek) · /.test(o.header.title.content),
  );
  assert.equal(sources.length, 3);
  assert.ok(sources.every((source) => source.expanded === false && !source.behaviors));
  const buttons = tagged(card, "button");
  assert.equal(buttons.length, 40);
  assert.equal(tagged(card, "select_static").length, 0);
  assert.equal(new Set(buttons.map((b) => b.behaviors[0].value.alias)).size, 40);
  assert.ok(buttons.every((b) => b.width === "fill" && b.behaviors[0].value.action === "detail"));
  for (const p of projects) assert.ok(buttons.some((b) => b.behaviors[0].value.alias === p.alias));
  assert.notEqual(buttons[0].text.content, buttons[1].text.content);
  assert.match(buttons[0].text.content, /^同名项目 · [a-f0-9]{6}$/);
  assert.equal(buttons[2].text.content, "项目 2 · 已启用");
  assert.equal(buttons[3].text.content, "项目 3 · 已暂停");
  assert.equal(buttons[4].text.content, "项目 4");
  assert.ok(!/上一页|下一页|翻页/.test(JSON.stringify(card)));
  assert.ok(JSON.stringify(card).includes("查看不会启用"));
  budget(card);
});

test("returning from a project keeps its source expanded without introducing another source callback", () => {
  const v = view();
  const p = v.projects.find((project) => project.provider === "multica");
  const detail = renderProjectCard(v, { screen: "detail", alias: p.alias }, context);
  const back = tagged(detail, "button").find((b) => b.behaviors[0].value.action === "home");
  assert.equal(back.behaviors[0].value.provider, "multica");
  const home = renderProjectCard(v, { screen: "home", provider: back.behaviors[0].value.provider }, context);
  const sources = home.body.elements.filter(
    (o) => o.tag === "collapsible_panel" && /^(Codex|Multica|DeepSeek) · /.test(o.header.title.content),
  );
  assert.equal(sources.filter((s) => s.expanded).length, 1);
  assert.match(sources.find((s) => s.expanded).header.title.content, /^Multica/);
  assert.ok(tagged(home, "button").every((b) => b.behaviors[0].value.action === "detail"));
  budget(home);
});

test("list pages show at most four projects and clamp stale, negative or oversized pages", () => {
  const v = view();
  for (const page of [-99, 0, 2, 999, NaN]) {
    const card = renderProjectCard(v, { screen: "list", provider: "codex", page }, context);
    const details = tagged(card, "button").filter((b) => b.behaviors[0].value.action === "detail");
    assert.ok(details.length >= 1 && details.length <= 4);
    assert.ok(details.every((b) => b.behaviors[0].value.alias.startsWith("C-")));
    for (const b of tagged(card, "button")) {
      const val = b.behaviors[0].value;
      assert.equal(val.session, context.sessionId);
      assert.equal(val.revision, context.revision);
      assert.equal(val.personal_loop, "projects-v1");
      assert.ok(!["enable", "pause", "resume"].includes(val.action));
      if (val.page !== undefined) assert.ok(Number.isSafeInteger(val.page) && val.page >= 0 && val.page < 7);
    }
    budget(card);
  }
});

test("detail exposes the current mode, goal and bounded capability with controls only as folded text", () => {
  const p = { ...project(1), execution: "managed-read-only", objective: "检查演示资料", maxSteps: 3 };
  const card = renderProjectCard(view([p]), { screen: "detail", alias: p.alias }, context);
  const text = JSON.stringify(card);
  assert.ok(text.includes("检查演示资料"));
  assert.ok(text.includes("只读任务"));
  assert.ok(text.includes("不接管原聊天"));
  assert.ok(text.includes(`/loop 启用 ${p.alias} | 明确目标`));
  assert.ok(text.includes("自动运行上限 3"));
  assert.ok(tagged(card, "collapsible_panel").every((panel) => panel.expanded === false));
  assert.deepEqual(
    new Set(tagged(card, "button").map((b) => b.behaviors[0].value.action)),
    new Set(["home", "refresh"]),
  );
  budget(card);
});

test("offline and partial sources never look like a verified empty catalogue", () => {
  const v = view([]);
  v.complete = false;
  v.providers[0] = { provider: "codex", status: "unavailable", complete: false };
  v.providers[1].complete = false;
  for (const interactive of [false, true]) {
    const card = renderProjectCard(v, {}, { ...context, interactive });
    const text = JSON.stringify(card);
    assert.ok(text.includes("Codex · 待连接"));
    assert.ok(text.includes("Multica · 未读全"));
    assert.ok(text.includes("DeepSeek"));
    assert.ok(text.includes("0 个项目"));
    assert.ok(!text.includes("全部来源已连接"));
    budget(card);
  }
});

test("names and goals cannot inject mentions, links, commands, or private object fields", () => {
  const p = {
    ...project(1),
    name: "<at id=all>hi</at> [click](https://bad.test) `x`",
    objective: "<at id=all>goal</at> &lt;link&gt; https://bad.test **bold**",
    root: "/private/secret/project",
    nativeId: "private-native-id",
    transcript: "private-conversation",
    apiKey: "private-credential",
  };
  for (const interactive of [true, false]) {
    const card = renderProjectCard(view([p]), { screen: "detail", alias: p.alias }, { ...context, interactive });
    const raw = JSON.stringify(card);
    assert.ok(!raw.includes("<at"));
    assert.ok(!raw.includes("https://bad"));
    for (const value of [p.root, p.nativeId, p.transcript, p.apiKey]) assert.ok(!raw.includes(value));
    assert.equal(objects(card).filter((o) => o.type === "open_url").length, 0);
    const md = tagged(card, "markdown")
      .map((o) => o.content)
      .join("\n");
    assert.ok(!md.includes("[click]"));
    budget(card);
  }
});

test("large and hostile long-name directories remain within the send budget and state omissions", () => {
  const projects = Array.from({ length: 1000 }, (_, i) => ({ ...project(i), name: "长名称&<>".repeat(40) }));
  const v = view(projects);
  for (const interactive of [false, true]) {
    const card = renderProjectCard(v, {}, { ...context, interactive });
    budget(card);
    assert.ok(JSON.stringify(card).includes("1000"));
    assert.match(JSON.stringify(card), /其余|更多|部分/);
  }
});

test("missing selected projects recover without inventing identity and invalid interactive sessions fail closed", () => {
  const card = renderProjectCard(view([]), { screen: "detail", alias: "C-fffffffffa" }, context);
  assert.ok(JSON.stringify(card).includes("未找到"));
  assert.ok(!JSON.stringify(card).includes("/loop 启用"));
  budget(card);
  for (const bad of [{}, { sessionId: "../../escape", revision: 0 }, { sessionId: "s", revision: -1 }])
    assert.throws(() => renderProjectCard(view(), {}, bad), /PROJECT_CARD_CONTEXT_INVALID/);
  assert.throws(() => renderProjectCard(view([project(1), project(1)]), {}, context), /PROJECT_CARD_DUPLICATE_ALIAS/);
});

test("a standalone status view defaults to project detail and supports a noninteractive result", () => {
  const card = renderProjectCard({ kind: "project-status", project: project(1) }, {}, { interactive: false });
  assert.ok(JSON.stringify(card).includes("项目 1"));
  assert.ok(JSON.stringify(card).includes(`/loop 状态 ${project(1).alias}`));
  assert.equal(tagged(card, "button").length, 0);
  budget(card);
});

test("static same-name entries use stable shortest distinct suffixes only within their source", () => {
  const a = { ...project(1), name: "广电", alias: "C-0000000001" };
  const b = { ...project(2), name: "广电", alias: "C-0001000001" };
  const otherSource = { ...project(3, "multica"), name: "广电" };
  const unique = { ...project(4), name: "唯一项目" };
  const card = renderProjectCard(view([a, b, otherSource, unique]), {}, { interactive: false });
  const titles = tagged(card, "collapsible_panel").map((o) => o.header.title.content);
  assert.ok(titles.includes("广电 · 0000001"));
  assert.ok(titles.includes("广电 · 1000001"));
  assert.equal(titles.filter((title) => title === "广电").length, 1);
  assert.ok(titles.includes("唯一项目"));
  const reversed = renderProjectCard(view([unique, otherSource, b, a]), {}, { interactive: false });
  const reversedTitles = tagged(reversed, "collapsible_panel").map((o) => o.header.title.content);
  assert.ok(reversedTitles.includes("广电 · 0000001"));
  assert.ok(reversedTitles.includes("广电 · 1000001"));
  budget(card);
});

test("static titles colliding after truncation are distinct and reveal their full names on expansion", () => {
  const common = "项目名称".repeat(22);
  const a = { ...project(1), name: common + "甲" };
  const b = { ...project(2), name: common + "乙" };
  const card = renderProjectCard(view([a, b]), {}, { interactive: false });
  const panels = tagged(card, "collapsible_panel").filter((o) => o.header.title.content.startsWith("项目名称"));
  assert.equal(panels.length, 2);
  assert.notEqual(panels[0].header.title.content, panels[1].header.title.content);
  assert.ok(panels[0].header.title.content.endsWith("… · 000001"));
  assert.ok(panels[1].header.title.content.endsWith("… · 000002"));
  assert.ok(JSON.stringify(panels[0].elements).includes(a.name));
  assert.ok(JSON.stringify(panels[1].elements).includes(b.name));
  budget(card);
});

const mutationContext = { sessionId: "a".repeat(24), revision: 8, interactive: true, mutationEnabled: true };
const actions = (card) =>
  tagged(card, "button").flatMap((button) => (button.behaviors ?? []).map((b) => b.value.action));
function controlledProject(extra = {}) {
  return {
    ...project(1),
    execution: "managed-read-only",
    controlRevision: 3,
    canSetGoal: true,
    canStart: false,
    canPause: false,
    canResume: false,
    ...extra,
  };
}

test("project controls follow backend capabilities and remain hidden from old read-only card contexts", () => {
  const cases = [
    {
      mode: "manual",
      canStart: true,
      draft: { objective: "检查文件", maxSteps: 3, revision: 1 },
      expected: ["edit-goal", "start"],
    },
    { mode: "active", canPause: true, expected: ["edit-goal", "pause"] },
    { mode: "paused", objective: "原目标", maxSteps: 3, canResume: true, expected: ["edit-goal", "resume"] },
  ];
  for (const item of cases) {
    const p = controlledProject(item);
    const card = renderProjectCard(view([p]), { screen: "detail", alias: p.alias }, mutationContext);
    for (const action of item.expected) assert.ok(actions(card).includes(action));
    for (const action of ["edit-goal", "start", "pause", "resume"].filter((a) => !item.expected.includes(a)))
      assert.ok(!actions(card).includes(action));
    const old = renderProjectCard(view([p]), { screen: "detail", alias: p.alias }, context);
    assert.deepEqual(new Set(actions(old)), new Set(["home", "refresh"]));
    budget(card);
  }
  const offline = controlledProject({ execution: "unavailable", canSetGoal: false, canPause: true, mode: "active" });
  const card = renderProjectCard(view([offline]), { screen: "detail", alias: offline.alias }, mutationContext);
  assert.ok(actions(card).includes("pause"));
  assert.ok(!actions(card).includes("start"));
  const pause = tagged(card, "button").find((b) => b.behaviors?.[0].value.action === "pause");
  assert.ok(pause.confirm.text.content.includes("不会取消"));
});

test("goal draft form binds submit to the exact session and revision without a mutating behavior", () => {
  const objective = "第一行\n第二行 <保留原文>";
  const p = controlledProject({ draft: { objective, maxSteps: 5, revision: 2 } });
  const card = renderProjectCard(view([p]), { screen: "goal", alias: p.alias }, mutationContext);
  const form = card.body.elements.find((o) => o.tag === "form");
  assert.equal(form.name, "goal_form");
  const input = tagged(form, "input")[0];
  assert.equal(input.name, "objective");
  assert.equal(input.input_type, "multiline_text");
  assert.equal(input.required, true);
  assert.equal(input.max_length, 1000);
  assert.equal(input.default_value, objective);
  const steps = tagged(form, "select_static")[0];
  assert.equal(steps.name, "max_steps");
  assert.deepEqual(
    steps.options.map((o) => o.value),
    ["1", "3", "5", "10"],
  );
  assert.equal(steps.initial_option, "5");
  const submit = tagged(form, "button")[0];
  assert.equal(submit.name, `plgoal_${mutationContext.sessionId}_${mutationContext.revision}`);
  assert.equal(submit.form_action_type, "submit");
  assert.equal(submit.behaviors, undefined);
  assert.ok(JSON.stringify(card).includes("保存草稿不会启动"));
  assert.ok(!actions(card).includes("confirm-start"));
  assert.ok(actions(card).includes("detail"));
  budget(card);
});

test("start confirmation shows the full 1000-character draft and explicit step budget before confirming", () => {
  const objective = "目标".repeat(500);
  const p = controlledProject({ canStart: true, draft: { objective, maxSteps: 3, revision: 2 } });
  const card = renderProjectCard(view([p]), { screen: "confirm-start", alias: p.alias }, mutationContext);
  assert.ok(tagged(card, "markdown").some((o) => o.content.includes(objective)));
  assert.ok(JSON.stringify(card).includes("最多 3 轮"));
  const confirm = tagged(card, "button").find((b) => b.behaviors?.[0].value.action === "confirm-start");
  assert.ok(confirm);
  assert.equal(confirm.behaviors[0].value.alias, p.alias);
  assert.equal(confirm.behaviors[0].value.session, mutationContext.sessionId);
  assert.equal(confirm.behaviors[0].value.revision, mutationContext.revision);
  assert.ok(confirm.confirm.text.content.includes(objective));
  assert.ok(confirm.confirm.text.content.includes("3 轮"));
  budget(card);
});

test("resume confirmation uses the running goal rather than an unrelated saved draft", () => {
  const p = controlledProject({
    mode: "paused",
    objective: "继续原目标",
    maxSteps: 5,
    canResume: true,
    draft: { objective: "以后才做的新目标", maxSteps: 1, revision: 2 },
  });
  const card = renderProjectCard(view([p]), { screen: "confirm-resume", alias: p.alias }, mutationContext);
  assert.ok(JSON.stringify(card).includes("继续原目标"));
  assert.ok(!JSON.stringify(card).includes("以后才做的新目标"));
  assert.ok(actions(card).includes("confirm-resume"));
  assert.ok(JSON.stringify(card).includes("不会重置"));
  budget(card);
});

test("no capability, oversized goals or invalid budgets can create a live confirmation or form", () => {
  for (const extra of [
    { canStart: false, draft: { objective: "valid", maxSteps: 3, revision: 1 } },
    { canStart: true, draft: { objective: "x".repeat(1001), maxSteps: 3, revision: 1 } },
    { canStart: true, draft: { objective: "valid", maxSteps: 101, revision: 1 } },
    { canStart: true, draft: { objective: "valid", maxSteps: 0, revision: 1 } },
  ]) {
    const p = controlledProject(extra);
    const card = renderProjectCard(view([p]), { screen: "confirm-start", alias: p.alias }, mutationContext);
    assert.ok(!actions(card).includes("confirm-start"));
    budget(card);
  }
  const p = controlledProject({ canSetGoal: false, canStart: true });
  for (const ctx of [mutationContext, context, { interactive: false }]) {
    const card = renderProjectCard(view([p]), { screen: "goal", alias: p.alias }, ctx);
    assert.equal(tagged(card, "form").length, 0);
    assert.ok(!actions(card).includes("confirm-start"));
  }
  assert.throws(
    () => renderProjectCard(view(), {}, { ...mutationContext, sessionId: "not-an-issued-session" }),
    /PROJECT_CARD_CONTEXT_INVALID/,
  );
});

test("probe is a single non-mutating verification action and notices stay within the page summary", () => {
  const card = renderProjectCard(view(), { screen: "probe" }, { ...context, notice: "尚未启动任何项目" });
  assert.deepEqual(actions(card), ["probe"]);
  assert.ok(JSON.stringify(card).includes("验证按钮连接"));
  assert.ok(JSON.stringify(card).includes("尚未启动任何项目"));
  assert.ok(JSON.stringify(card).includes("不会启动项目"));
  budget(card);
  const p = controlledProject({ draft: { objective: "已保存的目标", maxSteps: 3, revision: 1 } });
  const detail = renderProjectCard(
    view([p]),
    { screen: "detail", alias: p.alias },
    { ...mutationContext, notice: "草稿已保存" },
  );
  assert.ok(JSON.stringify(detail).includes("草稿已保存"));
  assert.ok(JSON.stringify(detail).includes("当前 仅查看"));
  assert.ok(!JSON.stringify(detail).includes("当前 已启用"));
  budget(detail);
});

const activityWork = (nativeId = "native-work-1", extra = {}) => ({
  nativeId,
  title: "所选会话",
  state: "completed",
  nativeState: "idle",
  updatedAt: "2026-11-05T08:00:00Z",
  membership: "native-project",
  ...extra,
});
const activity = (extra = {}) => ({
  status: "available",
  observedAt: "2026-11-05T09:00:00Z",
  complete: true,
  selection: "latest-updated",
  works: [activityWork()],
  selected: {
    ...activityWork(),
    latestReply: {
      text: "这是助手原文\n下一行",
      at: "2026-11-05T08:30:00Z",
      id: "reply-id",
      phase: "final_answer",
      truncated: false,
      timeSource: "turn-completed",
    },
  },
  ...extra,
});

test("project mode and native progress stay separate while the latest reply keeps its provenance", () => {
  const p = controlledProject({ mode: "active", canPause: true, activity: activity() });
  const card = renderProjectCard(view([p]), { screen: "detail", alias: p.alias }, mutationContext);
  const raw = JSON.stringify(card);
  assert.ok(raw.includes("当前 已启用"));
  assert.ok(raw.includes("本轮已结束"));
  assert.ok(raw.includes("所选会话"));
  assert.ok(raw.includes("按更新时间选择"));
  assert.ok(raw.includes("最近最终回复"));
  assert.ok(raw.includes("本轮结束时间"));
  assert.ok(raw.includes("读取时间"));
  assert.ok(tagged(card, "markdown").some((m) => m.content.includes("> 这是助手原文\n> 下一行")));
  assert.ok(!raw.includes("当前正在执行"));
  assert.ok(
    actions(card).includes("pause") && actions(card).includes("refresh") && actions(card).includes("activity-refresh"),
  );
  budget(card);
});

test("activity selectors are scoped callbacks only, capped at three and never display native identifiers", () => {
  const works = Array.from({ length: 6 }, (_, i) => activityWork("native-secret-id-" + i, { title: "会话 " + i }));
  const p = controlledProject({ activity: activity({ works, selected: { ...works[0], latestReply: null } }) });
  const card = renderProjectCard(view([p]), { screen: "detail", alias: p.alias }, mutationContext);
  const selectors = tagged(card, "button").filter((b) => b.behaviors?.[0]?.value.action === "activity-work");
  assert.equal(selectors.length, 3);
  for (const [i, b] of selectors.entries()) {
    assert.equal(b.behaviors[0].value.alias, p.alias);
    assert.equal(b.behaviors[0].value.workId, works[i].nativeId);
    assert.equal(b.behaviors[0].value.session, mutationContext.sessionId);
    assert.equal(b.behaviors[0].value.revision, mutationContext.revision);
    assert.ok(!b.text.content.includes("native-secret-id"));
  }
  assert.ok(tagged(card, "markdown").every((m) => !m.content.includes("native-secret-id")));
  budget(card);
});

test("activity replies preserve lines, escape markup and explicitly cap excerpts at 1600 characters", () => {
  const selected = {
    ...activityWork(),
    root: "/private/not-for-card",
    secret: "private-credential",
    latestReply: {
      text: "<at id=all>测试</at>\n[链接](https://bad.test) " + "字".repeat(1700),
      at: null,
      id: "private-reply-id",
      phase: "commentary",
      truncated: false,
      timeSource: "unknown",
      tool: "private-tool",
    },
  };
  const p = controlledProject({ activity: activity({ selected, secret: "private-activity", note: "仅显示有限回复" }) });
  const card = renderProjectCard(view([p]), { screen: "detail", alias: p.alias }, mutationContext);
  const raw = JSON.stringify(card),
    mds = tagged(card, "markdown").map((m) => m.content);
  assert.ok(raw.includes("最近进展"));
  assert.ok(raw.includes("已截断"));
  assert.ok(!raw.includes("<at"));
  assert.ok(!raw.includes("https://bad.test"));
  assert.ok(
    !raw.includes("private-credential") &&
      !raw.includes("private-tool") &&
      !raw.includes("private-activity") &&
      !raw.includes("private-reply-id"),
  );
  assert.ok(!raw.includes("/private/not-for-card"));
  assert.ok(mds.some((m) => m.includes("\n> ")));
  assert.ok(!raw.includes("字".repeat(1601)));
  budget(card);
});

test("unknown, empty, stale and failed activity do not imply that the Agent has done no work", () => {
  for (const status of ["empty", "unavailable", "stale", "loading"]) {
    const p = controlledProject({
      activity: activity({
        status,
        complete: false,
        selected: { ...activityWork("x", { state: "unknown", membership: "cwd-unassigned" }), latestReply: null },
        note: "连接需要核对",
      }),
    });
    const card = renderProjectCard(view([p]), { screen: "detail", alias: p.alias }, mutationContext);
    const raw = JSON.stringify(card);
    assert.ok(raw.includes("待核对") || raw.includes("尚未") || raw.includes("暂时") || raw.includes("缓存"));
    assert.ok(!raw.includes("Agent没有工作") && !raw.includes("Agent 没有工作"));
    if (status === "stale") assert.ok(raw.includes("缓存"));
    if (status !== "empty" && status !== "unavailable" && status !== "loading") assert.ok(raw.includes("目录关联"));
    budget(card);
  }
  const p = controlledProject({
    activity: activity({
      selected: { ...activityWork("x", { state: "unknown", membership: "cwd-unassigned" }), latestReply: null },
    }),
  });
  const card = renderProjectCard(view([p]), { screen: "detail", alias: p.alias }, { interactive: false });
  assert.ok(JSON.stringify(card).includes("待核对"));
  assert.ok(JSON.stringify(card).includes("目录关联"));
  assert.equal(tagged(card, "button").length, 0);
  budget(card);
});

test("the mobile detail separates the previous goal from an active goal and puts available actions before history", () => {
  const objective = "核对试用条件。" + "私有的执行细节。".repeat(50);
  const make = (extra) => {
    const p = controlledProject({ objective, maxSteps: 3, activity: activity(), ...extra });
    return renderProjectCard(view([p]), { screen: "detail", alias: p.alias }, mutationContext);
  };
  const visible = (o) => {
    if (o?.tag === "collapsible_panel" && !o.expanded) return o.header.title.content;
    if (Array.isArray(o)) return o.map(visible).join(" ");
    if (o && typeof o === "object")
      return Object.entries(o)
        .filter(([k]) => !["behaviors", "confirm"].includes(k))
        .map(([, v]) => visible(v))
        .join(" ");
    return typeof o === "string" ? o : "";
  };
  for (const extra of [{ mode: "manual" }, { mode: "active", canPause: true }, { mode: "paused", canResume: true }]) {
    const card = make(extra);
    const first = visible(card);
    assert.ok(!first.includes("私有的执行细节"));
    assert.ok(JSON.stringify(card).includes("私有的执行细节"));
    if (extra.mode === "manual") {
      assert.ok(!first.includes("当前目标"));
      assert.ok(first.includes("设置目标"));
      assert.ok(first.indexOf("设置目标") < first.indexOf("目标详情"));
    } else assert.ok(first.includes("核对试用条件"));
  }
  const d = make({
    mode: "manual",
    draft: { objective: "准备员工试用清单。草稿中详细的验收和分配要求", maxSteps: 3, revision: 1 },
    canStart: true,
  });
  assert.ok(visible(d).includes("草稿"));
  assert.ok(visible(d).includes("准备员工试用清单"));
  assert.ok(!visible(d).includes("草稿中详细的验收和分配要求"));
});
