// Failures covered: ordinary chat swallowed as control, ambiguous project targeting, implicit enable,
// offline pause failure, stale enable undoing pause, and unconfirmed rule sync reported as active.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopControls } from "./controls.mjs";
import * as commandViews from "./feishu-commands.mjs";
import { projectKey } from "./catalog.mjs";
import { parseLoopCommand, projectAlias, formatProjects, handleLoopCommand } from "./feishu-commands.mjs";

const makeProject = (provider, nativeId, name = "同名项目", canContinue = true) => ({
  key: projectKey(provider, "local", nativeId),
  provider,
  host: "local",
  nativeId,
  name,
  capabilities: { read: true, continue: canContinue, cancel: false },
});
const a = makeProject("codex", "a"),
  b = makeProject("multica", "b");
function setup(t, projects = [a, b]) {
  const folder = mkdtempSync(path.join(tmpdir(), "feishu-command-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const controls = new LoopControls(path.join(folder, "controls.json"));
  const catalog = {
    refresh: async () => ({
      complete: true,
      projects,
      providers: [{ provider: "codex", status: "connected", complete: true }],
    }),
  };
  return {
    controls,
    catalog,
    actor: "owner",
    requestId: "message-1",
    readiness: async () => ({ ready: true, rulesReady: true }),
  };
}

test("ordinary chat and lookalike prefixes remain ordinary messages", () => {
  for (const text of [
    "帮我继续项目",
    "这个 /loop 项目 是什么",
    "/loopback",
    "looping 状态",
    "@大肥鱼 项目",
    "项目列表",
    null,
  ])
    assert.equal(parseLoopCommand(text), null);
});
test("explicit Chinese commands parse without interpreting task text", () => {
  assert.deepEqual(parseLoopCommand(" /loop 项目 "), { action: "projects" });
  assert.deepEqual(parseLoopCommand("loop 状态"), { action: "status" });
  assert.deepEqual(parseLoopCommand("/loop 暂停 C-abcd"), { action: "pause", target: "C-abcd" });
  assert.deepEqual(parseLoopCommand("/loop 继续 C-abcd"), { action: "resume", target: "C-abcd" });
  assert.deepEqual(parseLoopCommand("/loop 启用 C-abcd | 检查 $(anything) 与原始资料"), {
    action: "enable",
    target: "C-abcd",
    objective: "检查 $(anything) 与原始资料",
    maxSteps: 3,
  });
  assert.deepEqual(parseLoopCommand("/loop 启用 C-abcd | 一个目标 | 步数 5"), {
    action: "enable",
    target: "C-abcd",
    objective: "一个目标",
    maxSteps: 5,
  });
});
test("reserved malformed commands fail explicitly rather than falling into issue creation", () => {
  for (const text of [
    "/loop",
    "/loop 乱来",
    "/loop 启用",
    "/loop 暂停",
    "/loop 项目 extra",
    "/loop 启用 C-abcd |",
    "/loop 启用 C-abcd | 目标 | 步数 0",
    "/loop 启用 C-abcd | 目标 | 步数 101",
  ])
    assert.throws(
      () => parseLoopCommand(text),
      (error) => error.code === "LOOP_COMMAND_USAGE" && Boolean(error.userMessage),
    );
});
test("short aliases are stable across list order and distinct across providers and hosts", () => {
  assert.equal(projectAlias(a), projectAlias({ ...a, name: "改名" }));
  assert.notEqual(projectAlias(a), projectAlias({ ...a, provider: "dsh" }));
  assert.notEqual(projectAlias(a), projectAlias({ ...a, host: "another" }));
  assert.match(projectAlias(a), /^C-[0-9a-f]{10}$/);
});
test("partial catalogue names unavailable sources and does not call them empty", (t) => {
  const ctx = setup(t);
  const text = formatProjects(
    {
      complete: false,
      projects: [makeProject("codex", "a", "名字\n<at id=all>", false)],
      providers: [
        { provider: "codex", status: "connected", complete: true },
        { provider: "dsh", status: "unavailable", complete: false },
      ],
    },
    ctx.controls,
  );
  assert.match(text, /DeepSeek：待连接/);
  assert.match(text, /仅查看/);
  assert.match(text, /只读/);
  assert.ok(!text.includes("<at"));
  assert.ok(!text.includes("DeepSeek：没有项目"));
});
test("missing actor is rejected before catalogue access or mode changes", async (t) => {
  const ctx = setup(t);
  let queried = false;
  ctx.catalog.refresh = async () => {
    queried = true;
    throw new Error();
  };
  const out = await handleLoopCommand({ action: "projects" }, { ...ctx, actor: "" });
  assert.equal(out.code, "LOOP_ACTOR_REQUIRED");
  assert.equal(queried, false);
});
test("same-name projects report ambiguity and allow a unique short ID", async (t) => {
  const ctx = setup(t);
  const out = await handleLoopCommand({ action: "enable", target: "同名项目", objective: "目标" }, ctx);
  assert.equal(out.ok, false);
  assert.equal(out.code, "PROJECT_TARGET_AMBIGUOUS");
  assert.equal(ctx.controls.list().length, 0);
  const selected = await handleLoopCommand({ action: "enable", target: projectAlias(b), objective: "目标" }, ctx);
  assert.equal(selected.projectKey, b.key);
  assert.equal(ctx.controls.get(a.key).mode, "manual");
});
test("enable requires a goal, finite budget, native control and deployed rule readiness", async (t) => {
  const ctx = setup(t);
  assert.equal((await handleLoopCommand({ action: "enable", target: a.key }, ctx)).code, "OBJECTIVE_REQUIRED");
  assert.equal(
    (await handleLoopCommand({ action: "enable", target: a.key, objective: "目标", maxSteps: 0 }, ctx)).code,
    "INVALID_STEP_BUDGET",
  );
  assert.equal(
    (await handleLoopCommand({ action: "enable", target: a.key, objective: "目标" }, { ...ctx, readiness: undefined }))
      .code,
    "LOOP_READINESS_REQUIRED",
  );
  assert.equal(
    (
      await handleLoopCommand(
        { action: "enable", target: a.key, objective: "目标" },
        { ...ctx, readiness: async () => ({ ready: true, rulesReady: false }) },
      )
    ).code,
    "LOOP_RULES_NOT_READY",
  );
  ctx.catalog.refresh = async () => ({
    projects: [{ ...a, capabilities: { read: true, continue: false } }],
    providers: [],
  });
  assert.equal(
    (await handleLoopCommand({ action: "enable", target: a.key, objective: "目标" }, ctx)).code,
    "PROJECT_CONTROL_NOT_READY",
  );
  assert.equal(ctx.controls.list().length, 0);
});
test("pause resolves a registered project alias even when the native provider is offline", async (t) => {
  const ctx = setup(t);
  ctx.controls.set(a.key, "active", { actor: "owner", objective: "目标", maxSteps: 3 });
  ctx.catalog.refresh = async () => ({
    complete: false,
    projects: [],
    providers: [{ provider: "codex", status: "unavailable" }],
  });
  const out = await handleLoopCommand({ action: "pause", target: projectAlias(a) }, ctx);
  assert.equal(out.ok, true);
  assert.equal(ctx.controls.get(a.key).mode, "paused");
  assert.match(out.text, /当前任务/);
  assert.equal(out.cancelRunning, false);
});
test("a newer pause during readiness cannot be overwritten by stale enable", async (t) => {
  const ctx = setup(t);
  ctx.readiness = async () => {
    ctx.controls.set(a.key, "paused", { actor: "owner" });
    return { ready: true, rulesReady: true };
  };
  const out = await handleLoopCommand({ action: "enable", target: a.key, objective: "目标" }, ctx);
  assert.equal(out.code, "CONTROL_REVISION_CHANGED");
  assert.equal(ctx.controls.get(a.key).mode, "paused");
});
test("resume preserves the selected goal and does not enable other projects", async (t) => {
  const ctx = setup(t);
  ctx.controls.set(a.key, "active", { actor: "owner", objective: "原目标", maxSteps: 4 });
  ctx.controls.set(a.key, "paused", { actor: "owner" });
  const out = await handleLoopCommand({ action: "resume", target: a.key }, ctx);
  assert.equal(out.ok, true);
  assert.equal(ctx.controls.get(a.key).objective, "原目标");
  assert.equal(ctx.controls.get(a.key).maxSteps, 4);
  assert.equal(ctx.controls.get(b.key).mode, "manual");
});
test("rule-sync failure cannot leave a newly enabled project active", async (t) => {
  const ctx = setup(t);
  ctx.syncRules = async () => {
    throw new Error("private details");
  };
  const out = await handleLoopCommand({ action: "enable", target: a.key, objective: "目标" }, ctx);
  assert.equal(out.ok, false);
  assert.equal(out.syncStatus, "unconfirmed");
  assert.equal(ctx.controls.get(a.key).mode, "paused");
  assert.ok(!out.text.includes("private details"));
});
test("pause remains paused if rule synchronization is unavailable", async (t) => {
  const ctx = setup(t);
  ctx.syncRules = async () => {
    throw new Error();
  };
  ctx.controls.set(a.key, "active", { actor: "owner", objective: "目标", maxSteps: 3 });
  const out = await handleLoopCommand({ action: "pause", target: a.key }, ctx);
  assert.equal(ctx.controls.get(a.key).mode, "paused");
  assert.equal(out.mode, "paused");
  assert.equal(out.syncStatus, "unconfirmed");
});
test("mode writes receive the outer stable request identity and cannot erase a newer mode on replay", async (t) => {
  const ctx = setup(t);
  const original = ctx.controls.set.bind(ctx.controls);
  let forwarded;
  ctx.controls.set = (key, mode, options) => {
    forwarded = options.requestId;
    return original(key, mode, options);
  };
  const out = await handleLoopCommand({ action: "enable", target: a.key, objective: "目标" }, ctx);
  assert.equal(out.ok, true);
  assert.equal(forwarded, ctx.requestId);
  const receipt = ctx.controls.get(a.key);
  original(a.key, "paused", { actor: "owner" });
  ctx.controls.set = () => receipt;
  const replay = await handleLoopCommand({ action: "enable", target: a.key, objective: "目标" }, ctx);
  assert.equal(replay.mode, "paused");
  assert.match(replay.text, /该指令已处理/);
});

test("question-card answers parse explicit positive one-based numbers", () => {
  assert.deepEqual(parseLoopCommand("/loop 回答 12 2"), { action: "answer", cardId: 12, choice: 2 });
  for (const text of [
    "/loop 回答 0 1",
    "/loop 回答 1 0",
    "/loop 回答 -1 1",
    "/loop 回答 1 1.5",
    "/loop 回答 1",
    "/loop 回答 9007199254740992 1",
  ]) {
    assert.throws(
      () => parseLoopCommand(text),
      (error) => error.code === "LOOP_COMMAND_USAGE",
    );
  }
});
test("answer delegates exact one-based choice and identity without querying projects", async () => {
  let received;
  const result = await handleLoopCommand(
    { action: "answer", cardId: 12, choice: 2 },
    {
      actor: "owner",
      requestId: "message-answer-1",
      answerCard: async (input) => {
        received = input;
        return { accepted: true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(received, { cardId: 12, choice: 2, actor: "owner", requestId: "message-answer-1" });
  assert.equal(result.cardId, 12);
  assert.equal(result.choice, 2);
});
test("answer requires authorization context and a stable request identity", async () => {
  let called = 0;
  const answerCard = async () => {
    called++;
    return { accepted: true };
  };
  const command = { action: "answer", cardId: 12, choice: 2 };
  assert.equal((await handleLoopCommand(command, { requestId: "m", answerCard })).code, "LOOP_ACTOR_REQUIRED");
  assert.equal((await handleLoopCommand(command, { actor: "owner", answerCard })).code, "COMMAND_ID_REQUIRED");
  assert.equal(
    (await handleLoopCommand({ ...command, choice: 0 }, { actor: "owner", requestId: "m", answerCard })).code,
    "LOOP_COMMAND_USAGE",
  );
  assert.equal(called, 0);
});
test("missing or failed answer callback never fabricates acceptance or exposes native details", async () => {
  const command = { action: "answer", cardId: 12, choice: 2 };
  const base = { actor: "owner", requestId: "m" };
  assert.equal((await handleLoopCommand(command, base)).code, "CARD_ANSWER_NOT_READY");
  const failure = await handleLoopCommand(command, {
    ...base,
    answerCard: async () => {
      throw new Error("private credential detail");
    },
  });
  assert.equal(failure.code, "CARD_ANSWER_FAILED");
  assert.ok(!JSON.stringify(failure).includes("private credential detail"));
  const refused = await handleLoopCommand(command, {
    ...base,
    answerCard: async () => ({ accepted: false, message: "private detail" }),
  });
  assert.equal(refused.ok, false);
  assert.ok(!JSON.stringify(refused).includes("private detail"));
});
test("duplicate card answer is not represented as another state change", async () => {
  const result = await handleLoopCommand(
    { action: "answer", cardId: 12, choice: 2 },
    { actor: "owner", requestId: "m", answerCard: async () => ({ accepted: true, duplicate: true }) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.match(result.text, /未重复|没有重复/);
});
test("managed read-only projects can be selected without claiming control of existing chats", async (t) => {
  const managed = {
    ...a,
    capabilities: { read: true, continue: false, startOwned: true, continuationMode: "managed-read-only" },
  };
  const ctx = setup(t, [managed]);
  const text = formatProjects(await ctx.catalog.refresh(), ctx.controls);
  assert.match(text, /受管只读/);
  assert.match(text, /不接管原聊天/);
  assert.ok(!text.includes("控制待接通"));
  const result = await handleLoopCommand({ action: "enable", target: a.key, objective: "只读检查并汇报" }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.text, /受管只读/);
  ctx.controls.set(a.key, "paused", { actor: "owner" });
  const resumed = await handleLoopCommand(
    { action: "resume", target: a.key },
    { ...ctx, requestId: "managed-resume-2" },
  );
  assert.equal(resumed.ok, true);
});
test("managed read-only capability still requires deployed rules and explicit readiness", async (t) => {
  const managed = {
    ...a,
    capabilities: { read: true, continue: false, startOwned: true, continuationMode: "managed-read-only" },
  };
  const ctx = setup(t, [managed]);
  const result = await handleLoopCommand(
    { action: "enable", target: a.key, objective: "只读检查" },
    { ...ctx, readiness: async () => ({ ready: true, rulesReady: false }) },
  );
  assert.equal(result.code, "LOOP_RULES_NOT_READY");
  assert.equal(ctx.controls.get(a.key).mode, "manual");
});

test("an answer callback without an explicit acknowledgement stays unconfirmed", async () => {
  const result = await handleLoopCommand(
    { action: "answer", cardId: 12, choice: 2 },
    {
      actor: "owner",
      requestId: "answer-without-ack",
      answerCard: async () => undefined,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "CARD_ANSWER_FAILED");
  assert.equal(result.changed, false);
  assert.ok(!result.text.includes("已提交问题"));
});

test("project-name targets preserve spaces and colons within strict command boundaries", () => {
  assert.deepEqual(parseLoopCommand("/loop 状态 内容 工作台:二期"), { action: "status", target: "内容 工作台:二期" });
  assert.deepEqual(parseLoopCommand("loop 暂停 Codex:内容 工作台:二期"), {
    action: "pause",
    target: "Codex:内容 工作台:二期",
  });
  assert.deepEqual(parseLoopCommand("/loop 继续 DeepSeek:资料 研究"), {
    action: "resume",
    target: "DeepSeek:资料 研究",
  });
  assert.deepEqual(parseLoopCommand("/loop 启用 Multica:内容 工作台:二期 | 核对结果 | 步数 4"), {
    action: "enable",
    target: "Multica:内容 工作台:二期",
    objective: "核对结果",
    maxSteps: 4,
  });
  for (const text of [
    "/loop 暂停 项目 | 其他",
    "/loop 状态 项目\t二期",
    "/loop 继续 项目\n二期",
    "/loop 启用 项目\t二期 | 目标",
    "/loop 启用 | 目标",
  ])
    assert.throws(
      () => parseLoopCommand(text),
      (error) => error.code === "LOOP_COMMAND_USAGE",
    );
});
test("a unique exact project name can be enabled and its verified name is forwarded", async (t) => {
  const project = makeProject("codex", "unique", "内容 工作台:二期");
  const ctx = setup(t, [project]);
  const set = ctx.controls.set.bind(ctx.controls);
  let savedName;
  ctx.controls.set = (key, mode, options) => {
    savedName = options.projectName;
    return set(key, mode, options);
  };
  const result = await handleLoopCommand({ action: "enable", target: "内容 工作台:二期", objective: "核对结果" }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.projectKey, project.key);
  assert.equal(savedName, project.name);
});
test("source-qualified names disambiguate otherwise identical native project names", async (t) => {
  const ctx = setup(t);
  const ambiguous = await handleLoopCommand({ action: "status", target: "同名项目" }, ctx);
  assert.equal(ambiguous.code, "PROJECT_TARGET_AMBIGUOUS");
  assert.match(ambiguous.text, /短编号/);
  const selected = await handleLoopCommand(
    { action: "enable", target: "Multica:同名项目", objective: "核对结果" },
    ctx,
  );
  assert.equal(selected.ok, true);
  assert.equal(selected.projectKey, b.key);
  assert.equal(ctx.controls.get(a.key).mode, "manual");
});
test("exact canonical keys and short IDs take precedence over coincidental project names", async (t) => {
  const other = makeProject("multica", "other", a.key);
  const third = makeProject("dsh", "third", projectAlias(a));
  const ctx = setup(t, [a, other, third]);
  assert.equal((await handleLoopCommand({ action: "status", target: a.key }, ctx)).projectKey, a.key);
  assert.equal((await handleLoopCommand({ action: "status", target: projectAlias(a) }, ctx)).projectKey, a.key);
});
test("qualified names retain subsequent colons instead of splitting native names", async (t) => {
  const project = makeProject("dsh", "notes", "资料: 第一期");
  const ctx = setup(t, [project]);
  const result = await handleLoopCommand({ action: "status", target: "DeepSeek:资料: 第一期" }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.projectKey, project.key);
});
test("a registered trusted name can pause offline without querying native providers", async (t) => {
  const ctx = setup(t);
  ctx.controls.set(a.key, "active", { actor: "owner", objective: "目标", maxSteps: 3 });
  const list = ctx.controls.list.bind(ctx.controls);
  ctx.controls.list = () => list().map((record) => ({ ...record, projectName: "离线 项目:一" }));
  let queried = false;
  ctx.catalog.refresh = async () => {
    queried = true;
    throw new Error();
  };
  const result = await handleLoopCommand({ action: "pause", target: "离线 项目:一" }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "paused");
  assert.equal(queried, false);
});
test("an invented stored display label is never treated as an authoritative native name", async (t) => {
  const ctx = setup(t);
  ctx.controls.set(a.key, "active", { actor: "owner", objective: "目标", maxSteps: 3 });
  ctx.catalog.refresh = async () => ({
    complete: false,
    projects: [],
    providers: [{ provider: "codex", status: "unavailable" }],
  });
  const result = await handleLoopCommand({ action: "pause", target: `已登记项目 ${projectAlias(a)}` }, ctx);
  assert.equal(result.code, "PROJECT_TARGET_NOT_FOUND");
  assert.equal(ctx.controls.get(a.key).mode, "active");
});
test("ambiguous registered names also refuse offline pause until source is specified", async (t) => {
  const ctx = setup(t);
  for (const project of [a, b])
    ctx.controls.set(project.key, "active", { actor: "owner", objective: "目标", maxSteps: 3 });
  const list = ctx.controls.list.bind(ctx.controls);
  ctx.controls.list = () => list().map((record) => ({ ...record, projectName: "同名项目" }));
  ctx.catalog.refresh = async () => {
    throw new Error();
  };
  assert.equal(
    (await handleLoopCommand({ action: "pause", target: "同名项目" }, ctx)).code,
    "PROJECT_TARGET_AMBIGUOUS",
  );
  const result = await handleLoopCommand({ action: "pause", target: "Multica:同名项目" }, ctx);
  assert.equal(result.ok, true);
  assert.equal(ctx.controls.get(b.key).mode, "paused");
  assert.equal(ctx.controls.get(a.key).mode, "active");
});
test("the project list explains natural exact names and qualified-name disambiguation", (t) => {
  const ctx = setup(t);
  const text = formatProjects({ projects: [a], providers: [], complete: true }, ctx.controls);
  assert.match(text, /项目名/);
  assert.match(text, /Codex:/);
  assert.match(text, /同名/);
});

test("project-name matching stays exact rather than accepting a partial name", async (t) => {
  const project = makeProject("codex", "one", "内容工作台完整名称");
  const ctx = setup(t, [project]);
  assert.equal(
    (await handleLoopCommand({ action: "status", target: "内容工作台" }, ctx)).code,
    "PROJECT_TARGET_NOT_FOUND",
  );
  for (const target of ["内容\u0085工作台", "内容\u2028工作台"]) {
    assert.throws(
      () => parseLoopCommand(`/loop 暂停 ${target}`),
      (error) => error.code === "LOOP_COMMAND_USAGE",
    );
    assert.equal((await handleLoopCommand({ action: "pause", target }, ctx)).code, "LOOP_COMMAND_USAGE");
  }
});

test("a pause received during catalogue refresh blocks the earlier enable request", async (t) => {
  const ctx = setup(t);
  ctx.catalog.refresh = async () => {
    ctx.controls.set(a.key, "paused", { actor: "newer-owner-decision" });
    return { complete: true, projects: [a], providers: [] };
  };
  let readinessCalled = false;
  ctx.readiness = async () => {
    readinessCalled = true;
    return { ready: true, rulesReady: true };
  };
  const result = await handleLoopCommand({ action: "enable", target: a.key, objective: "旧启用目标" }, ctx);
  assert.equal(result.code, "CONTROL_REVISION_CHANGED");
  assert.equal(ctx.controls.get(a.key).mode, "paused");
  assert.equal(readinessCalled, false);
});
test("catalogue-time changes to another project do not block the selected project", async (t) => {
  const ctx = setup(t);
  ctx.catalog.refresh = async () => {
    ctx.controls.set(b.key, "paused", { actor: "another-project-owner" });
    return { complete: true, projects: [a, b], providers: [] };
  };
  const result = await handleLoopCommand({ action: "enable", target: a.key, objective: "选定目标" }, ctx);
  assert.equal(result.ok, true);
  assert.equal(ctx.controls.get(a.key).mode, "active");
  assert.equal(ctx.controls.get(b.key).mode, "paused");
});

test("project directory view minimizes native data and leaves markup escaping to the renderer", () => {
  const project = {
    ...makeProject("codex", "PRIVATE_NATIVE_ID", "<原生标题>\n" + "名".repeat(150)),
    roots: ["/private/internal/root"],
    credentials: { token: "PRIVATE_CREDENTIAL" },
    preview: "PRIVATE_CHAT_BODY",
    nativeState: { details: "PRIVATE_NATIVE_STATE" },
  };
  const controls = {
    list: () => [],
    get: () => ({ mode: "active", revision: 7, objective: "目标\n<保留原字>", maxSteps: 3, actor: "PRIVATE_ACTOR" }),
  };
  const view = commandViews.projectDirectoryView(
    {
      complete: true,
      projects: [project],
      providers: [
        {
          provider: "codex",
          status: "connected",
          complete: true,
          error: "PRIVATE_ERROR",
          endpoint: "PRIVATE_ENDPOINT",
        },
      ],
    },
    controls,
  );
  assert.deepEqual(Object.keys(view).sort(), ["complete", "kind", "projects", "providers"]);
  assert.equal(view.kind, "project-directory");
  assert.equal(view.complete, true);
  assert.deepEqual(view.providers, [{ provider: "codex", status: "connected", complete: true }]);
  const row = view.projects[0];
  assert.deepEqual(Object.keys(row).sort(), [
    "alias",
    "execution",
    "maxSteps",
    "mode",
    "name",
    "objective",
    "provider",
    "revision",
  ]);
  assert.equal(row.execution, "native");
  assert.equal(row.revision, 7);
  assert.equal(row.mode, "active");
  assert.ok(row.name.startsWith("<原生标题>"));
  assert.ok([...row.name].length <= 140);
  assert.ok(!/[\p{Cc}\u2028\u2029]/u.test(row.name));
  assert.equal(row.objective, "目标 <保留原字>");
  const serialized = JSON.stringify(view);
  for (const privateValue of [
    "PRIVATE_NATIVE_ID",
    "/private/internal/root",
    "PRIVATE_CREDENTIAL",
    "PRIVATE_CHAT_BODY",
    "PRIVATE_NATIVE_STATE",
    "PRIVATE_ACTOR",
    "PRIVATE_ERROR",
    "PRIVATE_ENDPOINT",
    "projectKey",
    "nativeId",
    "roots",
    "credentials",
  ])
    assert.ok(!serialized.includes(privateValue), privateValue);
});

test("directory aliases stay unique for same-named projects across providers and hosts", () => {
  const projects = [
    makeProject("codex", "one"),
    makeProject("multica", "one"),
    { ...makeProject("codex", "one"), host: "other", key: projectKey("codex", "other", "one") },
  ];
  const view = commandViews.projectDirectoryView({ complete: true, projects, providers: [] });
  assert.equal(new Set(view.projects.map((x) => x.alias)).size, 3);
  assert.ok(view.projects.every((x) => x.name === "同名项目" && x.mode === "manual" && x.revision === 0));
});

test("directory execution modes distinguish managed read-only, native, read-only, and unavailable", () => {
  const projects = [
    {
      ...makeProject("codex", "managed"),
      capabilities: { read: true, continue: false, startOwned: true, continuationMode: "managed-read-only" },
    },
    makeProject("codex", "native"),
    makeProject("dsh", "read", "只读项目", false),
    { ...makeProject("multica", "unavailable"), capabilities: { read: false, continue: false } },
  ];
  assert.deepEqual(
    commandViews.projectDirectoryView({ projects, providers: [], complete: true }).projects.map((x) => x.execution),
    ["managed-read-only", "native", "read-only", "unavailable"],
  );
});

test("offline registered projects remain visible as unavailable and can still be paused", async (t) => {
  const ctx = setup(t);
  ctx.controls.set(a.key, "active", { actor: "owner", objective: "原目标", maxSteps: 3, projectName: "原生离线项目" });
  ctx.catalog.refresh = async () => ({
    complete: false,
    projects: [],
    providers: [{ provider: "codex", status: "unavailable", complete: false, errorCode: "PRIVATE_FAILURE" }],
  });
  const result = await handleLoopCommand({ action: "projects" }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.view.complete, false);
  assert.equal(result.view.projects[0].alias, projectAlias(a));
  assert.equal(result.view.projects[0].execution, "unavailable");
  assert.equal(result.view.projects[0].mode, "active");
  const paused = await handleLoopCommand({ action: "pause", target: projectAlias(a) }, ctx);
  assert.equal(paused.ok, true);
  assert.equal(ctx.controls.get(a.key).mode, "paused");
  const status = await handleLoopCommand({ action: "status", target: projectAlias(a) }, ctx);
  assert.equal(status.ok, true);
  assert.equal(status.view.kind, "project-status");
  assert.equal(status.view.project.mode, "paused");
  assert.equal(status.view.project.execution, "unavailable");
});

test("projects and status add matching views without changing original text or control state", async (t) => {
  const ctx = setup(t, [a]);
  const overview = await ctx.catalog.refresh();
  for (const command of [{ action: "projects" }, { action: "status" }]) {
    const result = await handleLoopCommand(command, ctx);
    assert.equal(result.text, formatProjects(overview, ctx.controls));
    assert.deepEqual(result.view, commandViews.projectDirectoryView(overview, ctx.controls));
    assert.equal(result.changed, false);
  }
  const status = await handleLoopCommand({ action: "status", target: projectAlias(a) }, ctx);
  assert.equal(status.view.kind, "project-status");
  assert.deepEqual(status.view.project, commandViews.projectDirectoryView(overview, ctx.controls).projects[0]);
  assert.equal(status.projectKey, a.key);
  assert.equal(ctx.controls.list().length, 0);
});
