// Ordinary progress, stored/partial turns and the bot's own work must not generate surprise group messages.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { BoundProgressNotices, noticeSignal } from "./bound-progress-notices.mjs";
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
