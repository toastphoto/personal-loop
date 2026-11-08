// Ordinary progress, stored/partial turns and the bot's own work must not generate surprise group messages.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";
import { BoundProgressNotices, noticeSignal } from "./bound-progress-notices.mjs";
import { boundChatClientId } from "./bound-chat.mjs";
import { runBoundStage } from "./bound-coordination.mjs";
import { readMessage, resultFrom } from "../../worker/contract.ts";
const projectKey = "codex:local:proj",
  threadId = "11111111-1111-1111-1111-111111111111";
const time = Date.now();
const turn = (id, text, extra = {}) => ({
  id,
  status: "completed",
  completedAt: (time + Number(id) * 1000) / 1000,
  itemsView: "full",
  items: [
    { type: "userMessage", id: "msg-" + id, content: [{ type: "text", text: "请检查项目" }] },
    { type: "agentMessage", phase: "final_answer", text },
  ],
  ...extra,
});
const stableText = "已交付：员工试用检查清单";
function fixture(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "progress-notice-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json"),
    hubFile = path.join(dir, "hub.json"),
    rulesFile = path.join(dir, "rules.json");
  const config = {
    profile: "bot",
    chatId: "oc_group",
    allowedSenderIds: ["ou_owner"],
    proactiveNotices: {
      enabled: true,
      enabledAt: new Date(time - 10000).toISOString(),
      stateFile: path.join(dir, "receipts.db"),
      intervalMs: 30000,
      targets: [{ projectKey, threadId, projectName: "测试工作台" }],
    },
  };
  const root = path.join(dir, "project");
  mkdirSync(root);
  const nativeConfig = {
    managedCodex: {
      enabled: true,
      stateDir: dir,
      coordinatorProjectKeys: [projectKey],
      projectRoots: { [projectKey]: root },
      boundChats: { [projectKey]: { threadId, projectId: "proj", root } },
    },
    providers: { codex: { allowConversationPreview: true } },
    loopHub: { configFile: hubFile, rulesFile },
  };
  writeFileSync(file, JSON.stringify(config));
  writeFileSync(
    hubFile,
    JSON.stringify({
      channels: { group: { use: "feishu-group-text", chatId: config.chatId, profile: config.profile } },
    }),
  );
  writeFileSync(rulesFile, JSON.stringify({ channels: { group: { answerers: ["ou_owner"] } } }));
  let now = time + 5000,
    latest = [turn("1", stableText)],
    ack = true;
  const calls = [];
  const runtime = {
    layout: () => ({
      source: {
        tell: async (p) => {
          calls.push(p);
          if (!ack) throw Error("lost ack");
          return { card: 17, duplicate: calls.length > 1 };
        },
      },
    }),
  };
  const create = () =>
    new BoundProgressNotices({
      configFile: file,
      config,
      nativeConfig,
      runtime,
      now: () => now,
      readRecent: async () => latest,
    });
  return {
    create,
    calls,
    config,
    nativeConfig,
    hubFile,
    set(v) {
      latest = v;
      now += 31000;
    },
    ack(v) {
      ack = v;
    },
  };
}
test("baseline is silent; one explicit new signal is stable across retries, repeat observations and restart", async (t) => {
  const f = fixture(t),
    w = f.create();
  await w.tick();
  assert.equal(f.calls.length, 0);
  f.set([turn("2", "需要你拍板：先试用哪条流程？"), turn("1", stableText)]);
  f.ack(false);
  await w.tick();
  assert.equal(f.calls.length, 1);
  f.ack(true);
  f.set([turn("2", "需要你拍板：先试用哪条流程？"), turn("1", stableText)]);
  await f.create().tick();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], f.calls[0]);
  f.set([turn("3", "需要你拍板：先试用哪条流程？"), turn("2", "需要你拍板：先试用哪条流程？")]);
  await f.create().tick();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].text, /测试工作台.*试用.*决定/);
});
test("skip routine reports, unsafe publication, handoffs, unverified binding, and a hub targeting multiple channels", async (t) => {
  const f = fixture(t);
  const w = f.create();
  await w.tick();
  const own = turn("2", stableText);
  own.items[0].content[0].text = "大肥鱼从飞书接到这个目标：其他工作";
  f.set([own, turn("1", stableText)]);
  await w.tick();
  assert.equal(f.calls.length, 0);
  f.set([turn("3", "我在检查资料。"), own]);
  await w.tick();
  f.set([turn("4", "当前受阻：请打开 https://test.example/private 解决"), turn("3", "我在检查资料。")]);
  await w.tick();
  assert.equal(f.calls.length, 0);
  writeFileSync(
    f.hubFile,
    JSON.stringify({
      channels: { group: { use: "feishu-group-text", chatId: "oc_group", profile: "bot" }, other: { use: "feishu" } },
    }),
  );
  f.set([turn("5", "已交付：真实样稿已就绪"), turn("4", "any")]);
  await w.tick();
  assert.equal(f.calls.length, 0);
});
test("only a single current final with an explicit, publishable attention signal qualifies", () => {
  for (const text of [
    "进行中",
    "已更新代码",
    "例子：需要你拍板：选一个",
    "已交付：日志 /Users/name/file.md",
    "已交付：abc sk-proj-PRIVATE1234567890123456789",
    "已交付：给 someone@example.com 的报价",
  ])
    assert.equal(noticeSignal(turn("2", text)), null, text);
  assert.equal(noticeSignal(turn("2", "受阻：缺少企业登录审批，尚待本人处理")).kind, "blocker");
  assert.equal(noticeSignal(turn("2", stableText)).kind, "milestone");
  assert.equal(noticeSignal(turn("2", stableText, { status: "interrupted" })), null);
});

test("a handoff recorded by client ID is suppressed even if its text changes; a rebound chat never inherits the old opt-in", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = fixture(t),
    w = f.create();
  const id = "33333333-3333-4333-8333-333333333333";
  const file = path.join(f.nativeConfig.managedCodex.stateDir, "bound-chat.db");
  const ledger = new DatabaseSync(file);
  ledger.exec("create table intents(id text primary key, fingerprint text not null)");
  ledger.prepare("insert into intents values (?,?)").run(id, "h");
  ledger.close();
  const { chmodSync } = await import("node:fs");
  chmodSync(file, 0o600);
  await w.tick();
  const linked = turn("2", "需要你拍板：要先做员工试用还是培训资料？");
  linked.items[0].clientId = id;
  f.set([linked, turn("1", stableText)]);
  await w.tick();
  assert.equal(f.calls.length, 0);
  f.nativeConfig.managedCodex.boundChats[projectKey].threadId = "22222222-2222-2222-2222-222222222222";
  f.set([turn("3", "受阻：缺少项目批准"), linked]);
  await w.tick();
  assert.equal(f.calls.length, 0);
});

test("a final request combines a present blocker and a concrete owner action; only the action category leaves the project", async (t) => {
  const f = fixture(t),
    w = f.create();
  await w.tick();
  const ask = turn("2", "已比对两份材料。\n\n目前缺少蓝鲸示范稿。请你补充一份可用的示范稿，我才能继续核对。");
  f.set([ask, turn("1", stableText)]);
  const result = await w.tick();
  assert.equal(result.sent, 1);
  assert.match(f.calls[0].text, /请在原对话补充/);
  assert.doesNotMatch(JSON.stringify(f.calls), /蓝鲸|示范稿/);
  f.set([turn("3", "已比对两份材料。\n\n目前缺少蓝鲸示范稿。请你补充一份可用的示范稿，我才能继续核对。"), ask]);
  await w.tick();
  assert.equal(f.calls.length, 1);
  for (const [body, expected] of [
    ["我已经重试，依然没有访问权限，需要你帮忙开通项目权限才能继续。", "在原系统"],
    ["目前缺少验收口径，麻烦你指定一位负责验收的同事。", "负责"],
    ["目前缺少访问权限，需要你提供访问权限才能继续。", "在原系统"],
  ]) {
    const s = noticeSignal(turn("2", body));
    assert.equal(s?.kind, "blocker");
    assert.ok(s.sentence.includes(expected));
  }
});

test("no waiting is inferred from ordinary review, quoted requests, ongoing work, or uncertain native states", () => {
  const ask = "目前缺少用户样例，请你补充资料，我才能继续。";
  for (const body of [
    "请你补充一条建议，我先继续整理。",
    "以前的卡点是缺少授权，已经解决。请你确认结果。",
    "说明示例：\n" + ask,
    "历史记录：\n\n" + ask,
    "如果暂时缺少资料，请你补充样例后再继续。",
    "> " + ask,
    "当前阻塞：权限尚未确认。\n权限已恢复，可以继续。",
    "\`\`\`text\n" + ask + "\n\`\`\`",
    "暂时缺一些资料，请在群里发送密码，我才能继续。",
    ask + "\n资料已收到，现在可以继续。",
    "此前缺少一项资料。\n\n请你补充样例。\n\n已改用现有材料继续处理。",
  ])
    assert.equal(noticeSignal(turn("2", body)), null, body);
  for (const status of ["inProgress", "interrupted", "failed"])
    assert.equal(noticeSignal(turn("2", ask, { status })), null);
});

test("message checkpoints report a completed feature before the parent turn ends and baseline is silent", async (t) => {
  const f = fixture(t);
  f.config.proactiveNotices.checkpoints = true;
  f.config.proactiveNotices.checkpointEnabledAt = new Date(time - 1000).toISOString();
  writeFileSync(path.join(path.dirname(f.hubFile), "config.json"), JSON.stringify(f.config));
  const item = (n, text) => ({
    turnId: "still-active-turn",
    itemId: "message-" + n,
    at: time + n * 1000,
    phase: "commentary",
    text,
  });
  let messages = [item(1, "已经接好导航入口。")],
    analyses = 0;
  const w = f.create();
  w.readItems = async () => ({ items: messages, complete: true });
  w.classifyCheckpoint = async (i) => {
    analyses++;
    return {
      kind: "milestone",
      topic: "保存和复用",
      summary: "保存和复用已接好，接下来做换样验证。",
      evidence: i.text,
    };
  };
  assert.equal((await w.tick()).baselined, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(analyses, 0);
  f.set([]);
  messages.push(item(10, "保存和复用已经接上了。"));
  f.ack(false);
  await w.tick();
  assert.equal(f.calls.length, 1);
  f.set([]);
  f.ack(true);
  await w.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(analyses, 1);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.match(f.calls[0].text, /原对话报告.*保存和复用/);
  f.set([]);
  messages.push(item(40, "保存和复用已接好。"));
  await w.tick();
  assert.equal(f.calls.length, 2, "same turn/topic recap stays quiet");
});
test("a checkpoint decision is persisted separately and callback retries keep one event identity", async (t) => {
  const f = fixture(t);
  f.config.proactiveNotices.checkpoints = true;
  f.config.proactiveNotices.checkpointEnabledAt = new Date(time - 1000).toISOString();
  writeFileSync(path.join(path.dirname(f.hubFile), "config.json"), JSON.stringify(f.config));
  const w = f.create();
  let items = [],
    ok = false;
  const callbacks = [];
  w.readItems = async () => ({ items, complete: true });
  w.classifyCheckpoint = async (i) => ({
    kind: "decision",
    topic: "导航入口",
    summary: "导航原型已具备，需要确定先看的部分。",
    question: "先看完整导航还是卡片库？",
    options: ["完整导航", "卡片库"],
    evidence: i.text,
  });
  w.onCheckpoint = async (e) => {
    callbacks.push(e);
    return { acknowledged: ok };
  };
  await w.tick();
  f.set([]);
  items = [{ turnId: "t", itemId: "i", at: time + 10000, phase: "partial_answer", text: "先看完整导航还是卡片库？" }];
  await w.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(callbacks.length, 1);
  f.set([]);
  ok = true;
  await w.tick();
  assert.equal(callbacks.length, 2);
  assert.deepEqual(callbacks[1], callbacks[0]);
  f.set([]);
  await w.tick();
  assert.equal(callbacks.length, 2);
  assert.equal(f.calls.length, 0);
});
test("a changed binding during checkpoint classification stops publication", async (t) => {
  const f = fixture(t);
  f.config.proactiveNotices.checkpoints = true;
  f.config.proactiveNotices.checkpointEnabledAt = new Date(time - 1000).toISOString();
  const file = path.join(path.dirname(f.hubFile), "config.json");
  writeFileSync(file, JSON.stringify(f.config));
  let items = [];
  const w = f.create();
  w.readItems = async () => ({ items, complete: true });
  w.classifyCheckpoint = async (i) => {
    f.config.proactiveNotices.enabled = false;
    writeFileSync(file, JSON.stringify(f.config));
    return { kind: "milestone", topic: "导航", summary: "导航已接好。", evidence: i.text };
  };
  await w.tick();
  f.set([]);
  items = [{ turnId: "t", itemId: "i", at: time + 10000, phase: "commentary", text: "导航已接好。" }];
  assert.equal((await w.tick()).status, "unavailable");
  assert.equal(f.calls.length, 0);
});

test("a stale checkpoint decision is terminal locally, while an unconfirmed delivery remains pending", async (t) => {
  const f = fixture(t);
  f.config.proactiveNotices.checkpoints = true;
  f.config.proactiveNotices.checkpointEnabledAt = new Date(time - 1000).toISOString();
  writeFileSync(path.join(path.dirname(f.hubFile), "config.json"), JSON.stringify(f.config));
  const w = f.create();
  let items = [],
    calls = 0;
  w.readItems = async () => ({ items, complete: true });
  w.classifyCheckpoint = async (i) => ({
    kind: "decision",
    topic: "导航",
    summary: "导航等确认。",
    question: "先看哪一项？",
    evidence: i.text,
  });
  w.onCheckpoint = async () => {
    calls++;
    return { acknowledged: false, code: "CHECKPOINT_STALE" };
  };
  await w.tick();
  f.set([]);
  items = [{ turnId: "t", itemId: "i", at: time + 10000, phase: "commentary", text: "请确认导航。" }];
  await w.tick();
  f.set([]);
  await w.tick();
  assert.equal(calls, 1);
  assert.equal(f.calls.length, 0);
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(f.config.proactiveNotices.stateFile, { readOnly: true });
  try {
    assert.deepEqual(
      d
        .prepare("select state from checkpoint_items where state='stale'")
        .all()
        .map((x) => x.state),
      ["stale"],
    );
  } finally {
    d.close();
  }
});

test("a managed original-turn final milestone is still reported when no exact final-result notice exists", async (t) => {
  const f = fixture(t);
  f.config.proactiveNotices.checkpoints = true;
  f.config.proactiveNotices.checkpointEnabledAt = new Date(time - 1000).toISOString();
  writeFileSync(path.join(path.dirname(f.hubFile), "config.json"), JSON.stringify(f.config));
  const w = f.create();
  let items = [];
  w.readItems = async () => ({ items, complete: true });
  w.classifyCheckpoint = async (i) => ({
    kind: "milestone",
    topic: "复用",
    summary: "规则复用功能已接好。",
    evidence: i.text,
  });
  await w.tick();
  f.set([]);
  items = [
    {
      turnId: "managed-turn",
      itemId: "final-item",
      at: time + 10000,
      phase: "final_answer",
      text: "规则复用已接好。",
      clientIds: ["known-loop-client"],
    },
  ];
  await w.tick();
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].text, /规则复用/);
});

test("only the exact bound final-result notice suppresses a final checkpoint, not another turn or continued progress", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createHash } = await import("node:crypto");
  const { chmodSync } = await import("node:fs");
  const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const f = fixture(t);
  f.config.proactiveNotices.checkpoints = true;
  f.config.proactiveNotices.checkpointEnabledAt = new Date(time - 1000).toISOString();
  writeFileSync(path.join(path.dirname(f.hubFile), "config.json"), JSON.stringify(f.config));
  const dir = path.join(f.nativeConfig.managedCodex.stateDir, hash(projectKey));
  mkdirSync(dir, { mode: 0o700 });
  const ledgerFile = path.join(dir, "worker.db");
  const l = new DatabaseSync(ledgerFile);
  l.exec("CREATE TABLE requests(run_id TEXT,result TEXT)");
  l.prepare("INSERT INTO requests VALUES(?,?)").run(
    "7",
    JSON.stringify({ coordinator: { action: "deliver", threadId, turnId: "done-turn" } }),
  );
  l.close();
  chmodSync(ledgerFile, 0o600);
  const hubFile = path.join(path.dirname(f.hubFile), "hub.db");
  const h = new DatabaseSync(hubFile);
  h.exec("CREATE TABLE projections(collection TEXT,data TEXT)");
  const rule = "native-project:" + createHash("sha256").update(projectKey).digest("hex");
  h.prepare("INSERT INTO projections VALUES(?,?)").run(
    "cards",
    JSON.stringify({ kind: "notice", run_id: 7, rule, key: "thread:" + rule + "::bound-result-native-run:6" }),
  );
  h.close();
  chmodSync(hubFile, 0o600);
  let items = [];
  const w = f.create();
  w.readItems = async () => ({ items, complete: true });
  w.classifyCheckpoint = async (i) => ({
    kind: "milestone",
    topic: "保存功能",
    summary: "保存功能已完成。",
    evidence: i.text,
  });
  await w.tick();
  f.set([]);
  items = [{ turnId: "done-turn", itemId: "done-item", at: time + 10000, phase: "final_answer", text: "保存已完成。" }];
  await w.tick();
  assert.equal(f.calls.length, 0);
  f.set([]);
  items.push({
    turnId: "next-turn",
    itemId: "next-item",
    at: time + 40000,
    phase: "final_answer",
    text: "保存已完成。",
  });
  await w.tick();
  assert.equal(f.calls.length, 1);
});

function checkpointDecisionFixture(t) {
  const f = fixture(t);
  f.config.proactiveNotices.checkpoints = true;
  f.config.proactiveNotices.checkpointEnabledAt = new Date(time - 1000).toISOString();
  writeFileSync(path.join(path.dirname(f.hubFile), "config.json"), JSON.stringify(f.config));
  const root = f.nativeConfig.managedCodex.stateDir;
  const workerDir = path.join(root, createHash("sha256").update(JSON.stringify(projectKey)).digest("hex"));
  mkdirSync(workerDir, { mode: 0o700 });
  const workerFile = path.join(workerDir, "worker.db"),
    queueFile = path.join(root, "bound-chat.db");
  const worker = new DatabaseSync(workerFile),
    queue = new DatabaseSync(queueFile);
  worker.exec(
    "CREATE TABLE requests(run_id TEXT,goal_id TEXT,request_id TEXT,state TEXT,result TEXT); CREATE TABLE bound_routes(goal_id TEXT PRIMARY KEY,binding TEXT)",
  );
  queue.exec("CREATE TABLE intents(id TEXT PRIMARY KEY,fingerprint TEXT)");
  chmodSync(workerFile, 0o600);
  chmodSync(queueFile, 0o600);
  t.after(() => {
    worker.close();
    queue.close();
  });
  const binding = f.nativeConfig.managedCodex.boundChats[projectKey];
  worker
    .prepare("INSERT INTO bound_routes VALUES(?,?)")
    .run("goal", JSON.stringify([threadId, binding.projectId, binding.root]));
  const record = (requestId, { regular = true, queued = true, runId = requestId.slice("native-run:".length) } = {}) => {
    const clientId = boundChatClientId(projectKey, requestId);
    if (regular) worker.prepare("INSERT INTO requests VALUES(?,?,?,?,NULL)").run(runId, "goal", requestId, "intent");
    if (queued) queue.prepare("INSERT INTO intents VALUES(?,?)").run(clientId, "verified-test-fingerprint");
    return clientId;
  };
  let items = [];
  const w = f.create(),
    callbacks = [];
  w.readItems = async () => ({ items, complete: true });
  w.classifyCheckpoint = async (i) =>
    i.text === "保存功能已完成。"
      ? { kind: "milestone", topic: "保存", summary: i.text, evidence: i.text }
      : {
          kind: i.itemId.includes("blocker") ? "blocker" : "decision",
          topic: "入口选择",
          summary: "入口需要确认。",
          question: "先看完整导航还是卡片库？",
          options: ["完整导航", "卡片库"],
          evidence: i.text,
        };
  w.onCheckpoint = async (event) => {
    callbacks.push(event);
    return { acknowledged: true };
  };
  return {
    ...f,
    w,
    callbacks,
    record,
    binding,
    setItems(v) {
      items = v;
    },
    states() {
      const db = new DatabaseSync(f.config.proactiveNotices.stateFile, { readOnly: true });
      try {
        return db
          .prepare("SELECT state,event FROM checkpoint_items ORDER BY at")
          .all()
          .map((r) => ({ state: r.state, event: r.event ? JSON.parse(r.event).event : null }));
      } finally {
        db.close();
      }
    },
  };
}

test("a normal worker's interim decision and blocker stay managed while its final uses the single kernel ask channel", async (t) => {
  const f = checkpointDecisionFixture(t);
  const clientId = f.record("native-run:8");
  await f.w.tick();
  f.set([]);
  const text = "需要你拍板：先看完整导航还是卡片库？\n1. 完整导航\n2. 卡片库\n建议选第 1 项，因为导航入口已有原型。";
  const item = (itemId, phase, at, body = text) => ({
    turnId: "run-turn",
    itemId,
    at,
    phase,
    text: body,
    clientIds: [clientId],
  });
  f.setItems([
    item("interim", "commentary", time + 10000),
    item("interim-blocker", "partial_answer", time + 11000),
    item("milestone", "commentary", time + 12000, "保存功能已完成。"),
  ]);
  await f.w.tick();
  assert.equal(f.callbacks.length, 0);
  assert.equal(f.calls.length, 1, "managed milestone still publishes in the middle of the turn");
  assert.deepEqual(
    f.states().map((r) => r.state),
    ["managed", "managed", "sent"],
  );
  assert.equal(f.states()[0].event.evidence, text, "grounded managed candidate is retained");
  const done = await runBoundStage(
    {
      config: f.nativeConfig,
      projectKey,
      binding: f.binding,
      stage: { role: "worker", plan: { nextStep: "核对入口", expectedResult: "可核对的入口" } },
      goal: { objective: "核对入口", maxSteps: null },
      goalId: "goal",
      runId: "8",
      executionKey: "8",
      remaining: Infinity,
      guard() {},
    },
    { queueBoundChat: async () => ({ status: "completed", threadId, turnId: "run-turn", reply: text }) },
  );
  const receipt = resultFrom(readMessage(done.text), {}).result;
  assert.equal(receipt.ask.length, 1);
  assert.equal(done.coordinator.action, "ask");
  f.set([]);
  f.setItems([item("interim", "commentary", time + 10000), item("final", "final_answer", time + 40000)]);
  await f.w.tick();
  f.set([]);
  await f.w.tick();
  assert.equal(f.callbacks.length, 0, "neither interim nor final creates a second self-owned decision card");
  assert.equal(f.states().filter((r) => r.state === "managed").length, 3);
});

test("manual and checkpoint-answer turns can still ask midway even with a regular run in the same project", async (t) => {
  const f = checkpointDecisionFixture(t);
  f.record("native-run:8");
  const answerClient = f.record("checkpoint-answer:card-1", { regular: false });
  await f.w.tick();
  f.set([]);
  f.setItems([
    {
      turnId: "manual-turn",
      itemId: "manual",
      at: time + 10000,
      phase: "commentary",
      text: "请确认导航。",
      clientIds: ["manual-client"],
    },
    {
      turnId: "answer-turn",
      itemId: "answer",
      at: time + 11000,
      phase: "partial_answer",
      text: "请确认卡片库。",
      clientIds: [answerClient],
    },
  ]);
  await f.w.tick();
  assert.deepEqual(
    f.callbacks.map((e) => e.turnId),
    ["manual-turn", "answer-turn"],
  );
  assert.deepEqual(
    f.states().map((r) => r.state),
    ["sent", "sent"],
  );
});

test("a queue intent or worker request alone cannot claim the managed decision channel", async (t) => {
  const f = checkpointDecisionFixture(t);
  const orphan = f.record("native-run:orphan", { regular: false });
  const unqueued = f.record("native-run:9", { queued: false });
  const forged = f.record("native-run:10", { runId: "11" });
  await f.w.tick();
  f.set([]);
  f.setItems(
    [orphan, unqueued, forged].map((clientId, n) => ({
      turnId: "other-turn-" + n,
      itemId: "other-" + n,
      at: time + 10000 + n,
      phase: "commentary",
      text: "请确认入口。",
      clientIds: [clientId],
    })),
  );
  await f.w.tick();
  assert.equal(f.callbacks.length, 3);
  assert.deepEqual(
    f.states().map((r) => r.state),
    ["sent", "sent", "sent"],
  );
});

test("compact automatic handoffs do not duplicate legacy whole-turn notices", () => {
  for (const text of ["大肥鱼续办\n\n本次：核对下一项。", "大肥鱼接续目标：核对入口"]) {
    const own = turn("compact", stableText);
    own.items[0].content[0].text = text;
    assert.equal(noticeSignal(own), null);
  }
});
