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
  assert.ok(titles.includes("项目 2 · 推进中"));
  assert.ok(titles.includes("项目 3 · 已暂停"));
  assert.ok(JSON.stringify(card).includes("默认仅查看"));
  budget(card);
});

test("home uses a project picker instead of visible rows and separates same-name native entries", () => {
  const v = view();
  v.projects[0].name = v.projects[1].name = "同名项目";
  const card = renderProjectCard(v, { screen: "home" }, context);
  const picker = tagged(card, "select_static")[0];
  assert.equal(picker.options.length, 39);
  assert.equal(new Set(picker.options.map((o) => o.value)).size, 39);
  assert.notEqual(picker.options[0].text.content, picker.options[1].text.content);
  assert.equal(picker.name, "project");
  assert.equal(picker.behaviors[0].value.action, "select");
  assert.ok(JSON.stringify(card).includes("查看不会启用"));
  budget(card);
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
  assert.ok(text.includes("步数上限 3"));
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
