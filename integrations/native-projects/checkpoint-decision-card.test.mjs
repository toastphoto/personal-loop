// Checkpoints must stay bound to the original source item, owner, group and message; retries may not submit work twice.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkpointItemFingerprint } from "./checkpoint-source.mjs";
import { CheckpointDecisionCards } from "./checkpoint-decision-card.mjs";
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function fixture(t, extra = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "checkpoint-card-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "project"),
    runtime = path.join(home, "runtime");
  mkdirSync(root);
  mkdirSync(runtime, { mode: 0o700 });
  const projectId = "project",
    projectKey = "codex:local:project",
    threadId = "12345678-1234-1234-1234-123456789012";
  let clock = Date.now(),
    valid = true;
  const start = new Date(clock - 1000).toISOString();
  const configFile = path.join(runtime, "relay.json"),
    nativeFile = path.join(runtime, "native.json"),
    hubFile = path.join(runtime, "hub.json"),
    rulesFile = path.join(runtime, "rules.json");
  const binding = { threadId, projectId, root };
  const config = {
    profile: "bot",
    chatId: "oc_group",
    allowedSenderIds: ["ou_owner"],
    nativeConfigFile: nativeFile,
    proactiveNotices: {
      enabled: true,
      enabledAt: start,
      checkpoints: true,
      checkpointEnabledAt: start,
      checkpointStateFile: path.join(runtime, "checkpoint.db"),
      targets: [{ projectKey, threadId, projectName: "项目工作台" }],
    },
  };
  const nativeConfig = {
    version: 1,
    providers: { codex: { allowConversationPreview: true } },
    managedCodex: {
      enabled: true,
      coordinatorProjectKeys: [projectKey],
      boundChats: { [projectKey]: binding },
      projectRoots: { [projectKey]: root },
      stateDir: path.join(runtime, "bound"),
    },
    loopHub: { configFile: hubFile, rulesFile },
  };
  for (const [f, v] of [
    [configFile, config],
    [nativeFile, nativeConfig],
    [hubFile, { channels: { group: { use: "feishu-group-text", profile: "bot", chatId: "oc_group" } } }],
    [rulesFile, { channels: { group: { answerers: ["ou_owner"] } } }],
  ])
    writeFileSync(f, JSON.stringify(v), { mode: 0o600 });
  const event = {
    projectKey,
    threadId,
    turnId: "turn-one",
    itemId: "message-one",
    at: clock,
    phase: "commentary",
    sourceHash: "a".repeat(64),
    kind: "decision",
    summary: "导航初版已经能用",
    question: "入口先放哪里？",
    evidence: "入口需要决定",
    options: ["放首页", "放项目里"],
    recommend: 1,
    reason: "项目资料会一起出现",
    eventKey: "checkpoint-" + "b".repeat(48),
    scope: hash(["bot", "oc_group", start, projectKey, binding]),
  };
  const sends = [],
    patches = [],
    queues = [],
    inspects = [];
  const deps = {
    configFile,
    config,
    nativeConfig,
    now: () => clock,
    validateSource: async () => valid,
    execute: async (program, args, opts) => {
      (args.includes("patch") ? patches : sends).push({ args, input: JSON.parse(opts.input) });
      if (extra.lostSend && sends.length === 1 && !args.includes("patch")) return { exitCode: 1, stdout: "" };
      if (extra.lostPatch && patches.length === 1 && args.includes("patch")) return { exitCode: 1, stdout: "" };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, data: { message_id: "om_card", chat_id: "oc_group" } }),
      };
    },
    queueBound: async (args) => {
      args.beforeMutation();
      queues.push(args);
      return { status: extra.queueStatus ?? "queued", threadId };
    },
    inspectBound: async (args) => {
      inspects.push(args);
      return { status: extra.inspectStatus ?? "queued", threadId };
    },
  };
  const service = new CheckpointDecisionCards(deps);
  const click = (id, more = {}) =>
    service.handle({
      id,
      version: 1,
      choice: 0,
      actor: "ou_owner",
      chat: "oc_group",
      messageId: "om_card",
      requestId: "callback-1",
      ...more,
    });
  return {
    home,
    service,
    deps,
    event,
    config,
    configFile,
    nativeConfig,
    nativeFile,
    sends,
    patches,
    queues,
    inspects,
    click,
    advance: (ms) => (clock += ms),
    setValid: (v) => (valid = v),
    editConfig: (fn) => {
      fn(config);
      writeFileSync(configFile, JSON.stringify(config));
    },
  };
}
test("a checkpoint is delivered once with one explicit owner mention and the owner choice queues only the original chat", async (t) => {
  const f = fixture(t);
  const a = await f.service.deliver(f.event);
  assert(a.acknowledged);
  assert.equal((await f.service.deliver(f.event)).id, a.id);
  assert.equal(f.sends.length, 1);
  assert.equal((JSON.stringify(f.sends[0].input).match(/<at id=ou_owner>/g) ?? []).length, 1);
  assert.match(JSON.stringify(f.sends[0].input), /personalLoopCheckpoint/);
  const answer = await f.click(a.id);
  assert.equal(answer.ok, true);
  assert.equal(answer.status, "queued");
  assert.equal(f.queues.length, 1);
  assert.equal(f.queues[0].projectKey, f.event.projectKey);
  assert.match(f.queues[0].text, /放首页/);
  assert.doesNotMatch(f.queues[0].text, /personalLoopCheckpoint|sourceHash/);
  assert.doesNotMatch(JSON.stringify(f.patches[0].input), /<at|personalLoopCheckpoint/);
  await f.click(a.id, { choice: 1, requestId: "second-click" });
  assert.equal(f.queues.length, 1);
});
test("wrong actor/ref/version/scope and a superseded source never queue work", async (t) => {
  const f = fixture(t),
    { id } = await f.service.deliver(f.event);
  for (const x of [
    { actor: "ou_other" },
    { chat: "oc_other" },
    { messageId: "om_other" },
    { version: 2 },
    { choice: 5 },
  ])
    assert.equal((await f.click(id, x)).ok, false);
  f.setValid(false);
  assert.equal((await f.click(id)).ok, false);
  assert.equal(f.queues.length, 0);
  f.setValid(true);
  f.editConfig((c) => (c.proactiveNotices.checkpoints = false));
  assert.equal((await f.click(id)).ok, false);
});
test("send and patch acknowledgements may be lost, but restart keeps one message and a single submission", async (t) => {
  const f = fixture(t, { lostSend: true, lostPatch: true, queueStatus: "unknown" });
  await assert.rejects(f.service.deliver(f.event));
  f.advance(35000);
  const svc = new CheckpointDecisionCards(f.deps);
  const a = await svc.deliver(f.event);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[0].args.at(-1), f.sends[1].args.at(-1));
  await assert.rejects(
    svc.handle({
      id: a.id,
      version: 1,
      choice: 0,
      actor: "ou_owner",
      chat: "oc_group",
      messageId: "om_card",
      requestId: "cb",
    }),
  );
  const again = new CheckpointDecisionCards(f.deps);
  assert.equal(
    (
      await again.handle({
        id: a.id,
        version: 1,
        choice: 0,
        actor: "ou_owner",
        chat: "oc_group",
        messageId: "om_card",
        requestId: "cb",
      })
    ).ok,
    true,
  );
  assert.equal(f.queues.length, 1);
});
test("without actual options a blocker is an informational request, not an invented choice", async (t) => {
  const f = fixture(t);
  delete f.event.options;
  delete f.event.recommend;
  delete f.event.reason;
  f.event.kind = "blocker";
  f.event.question = "请补充一份验收样例";
  const r = await f.service.deliver(f.event);
  assert(r.acknowledged);
  assert.doesNotMatch(JSON.stringify(f.sends[0].input), /personalLoopCheckpoint|按钮/);
  assert.equal((await f.click(r.id)).ok, false);
  assert.equal(f.queues.length, 0);
});

test("source identity and a later final answer invalidate a prior checkpoint choice", async (t) => {
  const f = fixture(t);
  const item = {
    turnId: f.event.turnId,
    itemId: f.event.itemId,
    at: f.event.at,
    phase: "commentary",
    text: "入口需要决定",
  };
  f.event.sourceHash = checkpointItemFingerprint(item);
  let items = [item];
  const service = new CheckpointDecisionCards({
    ...f.deps,
    validateSource: undefined,
    readItems: async () => ({ items, complete: true }),
  });
  const { id } = await service.deliver(f.event);
  items = [
    item,
    {
      ...item,
      turnId: "later-turn",
      itemId: "later-final",
      phase: "final_answer",
      text: "已经按新方向完成",
      at: item.at + 1,
    },
  ];
  f.advance(2);
  const result = await service.handle({
    id,
    version: 1,
    choice: 0,
    actor: "ou_owner",
    chat: "oc_group",
    messageId: "om_card",
  });
  assert.equal(result.ok, false);
  assert.equal(f.queues.length, 0);
  assert.match(JSON.stringify(f.patches.at(-1).input), /问题已更新/);
  assert.doesNotMatch(JSON.stringify(f.patches.at(-1).input), /personalLoopCheckpoint/);
});

test("overlapping owner clicks have one durable choice and one native submission", async (t) => {
  const f = fixture(t);
  let release, started;
  const ready = new Promise((r) => (started = r)),
    gate = new Promise((r) => (release = r));
  let submits = 0;
  const service = new CheckpointDecisionCards({
    ...f.deps,
    queueBound: async (args) => {
      args.beforeMutation();
      submits++;
      started();
      await gate;
      return { status: "queued", threadId: f.event.threadId };
    },
  });
  const { id } = await service.deliver(f.event);
  const click = { id, version: 1, choice: 0, actor: "ou_owner", chat: "oc_group", messageId: "om_card" };
  const first = service.handle(click);
  await ready;
  const other = new CheckpointDecisionCards(f.deps);
  await assert.rejects(other.handle({ ...click, choice: 1 }), { code: "CHECKPOINT_ANSWER_PENDING" });
  release();
  assert.equal((await first).ok, true);
  assert.equal((await other.handle({ ...click, choice: 1 })).ok, true);
  assert.equal(submits, 1);
  assert.equal(f.queues.length, 0);
  assert.match(JSON.stringify(f.patches.at(-1).input), /放首页/);
});

test("a later final can repeat the same unresolved question without cancelling its checkpoint", async (t) => {
  const f = fixture(t);
  const item = {
    turnId: f.event.turnId,
    itemId: f.event.itemId,
    at: f.event.at,
    phase: "commentary",
    text: "入口需要决定",
  };
  f.event.sourceHash = checkpointItemFingerprint(item);
  f.advance(5);
  let final = {
    ...item,
    itemId: "final",
    at: item.at + 1,
    phase: "final_answer",
    text: "需要你拍板：入口先放哪里？\n1. 放首页\n2. 放项目里",
  };
  const service = new CheckpointDecisionCards({
    ...f.deps,
    validateSource: undefined,
    readItems: async (n, target, opts) => {
      assert.deepEqual(opts.through, { turnId: item.turnId, itemId: item.itemId });
      return { items: [item, final], complete: true };
    },
  });
  assert.equal(await service.sourceValid(f.event, service.settings(f.event)), true);
  final = { ...final, text: "请确认下一步。", questions: [{ title: f.event.question, options: f.event.options }] };
  assert.equal(await service.sourceValid(f.event, service.settings(f.event)), true);
  final = {
    ...final,
    text: "已选定放首页，下面记录原问题。",
    questions: [{ title: f.event.question, options: f.event.options }],
  };
  assert.equal(await service.sourceValid(f.event, service.settings(f.event)), false);
  final = { ...final, text: "需要你决定登录方式。", questions: [{ title: "登录方式？", options: f.event.options }] };
  assert.equal(await service.sourceValid(f.event, service.settings(f.event)), false);
});

test("pending returns only delivered open and current source projects, and exposes uncertainty without content", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.service.pending(), { projectKeys: [], complete: true });
  const delivered = await f.service.deliver(f.event);
  assert.deepEqual(await f.service.pending(), { projectKeys: [f.event.projectKey], complete: true });
  const pending = JSON.stringify(await f.service.pending());
  assert.ok(!pending.includes(f.event.threadId) && !pending.includes(f.event.question));
  f.setValid(false);
  assert.deepEqual(await f.service.pending(), { projectKeys: [], complete: true });
  f.setValid(true);
  await f.click(delivered.id);
  assert.deepEqual(await f.service.pending(), { projectKeys: [], complete: true });
  const g = fixture(t);
  await g.service.deliver(g.event);
  g.deps.validateSource = async () => {
    throw Error("offline");
  };
  assert.deepEqual(await new CheckpointDecisionCards(g.deps).pending(), { projectKeys: [], complete: false });
  const h = fixture(t);
  await h.service.deliver(h.event);
  h.deps.validateSource = () => new Promise(() => {});
  assert.deepEqual(await new CheckpointDecisionCards(h.deps).pending({ timeoutMs: 5 }), {
    projectKeys: [],
    complete: false,
  });
});
