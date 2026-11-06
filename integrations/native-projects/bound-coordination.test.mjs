// A bound goal must never fork a project chat, count status reads as work, or publish the wrong turn.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoopControls, subjectFor } from "./controls.mjs";
import { runManagedWorker } from "./managed-worker.mjs";
import { readMessage, resultFrom } from "../../worker/contract.ts";
function fixture(t, maxSteps = 2) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bound-managed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "source");
  mkdirSync(cwd);
  writeFileSync(path.join(cwd, "AGENTS.md"), "Current phase: wiring the real capture client.");
  const projectKey = "codex:local:pr1",
    projectId = "pr1",
    threadId = "a01f5d43-7fb2-4d99-9201-b8d5a5295e10",
    project = { nativeId: projectId, provider: "codex", key: projectKey, roots: [cwd] };
  const config = {
    controlsFile: path.join(dir, "control.json"),
    managedCodex: {
      enabled: true,
      stateDir: path.join(dir, "state"),
      coordinatorProjectKeys: [projectKey],
      projectRoots: { [projectKey]: cwd },
      boundChats: { [projectKey]: { threadId, root: cwd, projectId } },
    },
    providers: { codex: { allowConversationPreview: true } },
  };
  const controls = new LoopControls(config.controlsFile);
  const goal = controls.set(projectKey, "active", {
    actor: "owner",
    requestId: "start-r",
    objective: "核对工作台入口",
    maxSteps,
  });
  const subject = subjectFor(projectKey),
    prefix = "native.project." + subject.slice(0, 32),
    calls = [];
  let planOverride;
  const queuedText = [];
  let originalReply = "建议先核对资料入口。";
  let inspectStatus = "queued",
    queueStatus = "queued";
  const run = async (num, events, extra = {}) => {
    const file = path.join(dir, "context" + num);
    writeFileSync(file, JSON.stringify({ events, answers: [], timers: [], ...extra }));
    const r = await runManagedWorker(
      { config, runId: String(num), projectKey, prompt: "legacy model instructions", contextFile: file },
      {
        controls,
        catalog: {
          async refresh() {},
          resolve() {
            return { project };
          },
          async close() {},
        },
        emit() {},
        executorFactory() {
          throw Error("unexpected own native thread");
        },
        readBoundProgress: async ({ threadId: id }) => {
          assert.equal(id, threadId);
          calls.push("read");
          return { excerpt: "主会话已将采集迁入工作台", title: "The primary chat", complete: true };
        },
        runEphemeralCoordinator: async ({ prompt, beforeStart }) => {
          beforeStart();
          assert.match(prompt, /已将采集迁入工作台/);
          assert.match(prompt, /real capture client/);
          calls.push("plan");
          return {
            text:
              planOverride ??
              JSON.stringify({
                action: "dispatch",
                progress: "已有采集入口",
                nextStep: "验证入口与界面关系",
                expectedResult: "三条说明",
              }),
            turnUsage: { input: 16, output: 12 },
            turnUsageStatus: "complete",
          };
        },
        queueBoundChat: async ({ text, beforeMutation, requestId }) => {
          beforeMutation();
          assert.match(text, /核对工作台入口/);
          assert.match(text, /验证入口/);
          assert.doesNotMatch(text, /agent-autoloop|expectedResult|纯 JSON/);
          calls.push("queue:" + requestId);
          queuedText.push(text);
          return {
            status: queueStatus,
            threadId,
            ...(queueStatus === "completed" ? { turnId: "sync-turn", reply: originalReply } : {}),
          };
        },
        inspectBoundChat: async ({ text, requestId }) => {
          assert.match(text, /验证入口/);
          calls.push("inspect:" + requestId);
          return {
            status: inspectStatus,
            threadId,
            ...(inspectStatus === "completed" ? { turnId: "real-turn", reply: originalReply } : {}),
          };
        },
      },
    );
    return { r, parsed: resultFrom(readMessage(r.text), {}).result };
  };
  return {
    run,
    calls,
    config,
    controls,
    projectKey,
    goal,
    subject,
    prefix,
    activeEvent: { id: goal.goalStartEvent, subject, type: prefix + ".changed" },
    queuedText,
    setReply: (v) => (originalReply = v),
    setInspect: (v) => (inspectStatus = v),
    setQueue: (v) => (queueStatus = v),
    setPlan: (v) => (planOverride = v),
  };
}
test("ephemeral plan, a single queued handoff, and checked final reply at the original thread within a two-attempt budget", async (t) => {
  const f = fixture(t);
  const first = await f.run(1, [f.activeEvent]);
  assert.equal(first.parsed.events?.length, 1, first.r.text);
  assert.equal(first.r.session, undefined);
  assert.deepEqual(first.r.usage, { input: 16, output: 12 });
  const second = await f.run(2, [first.parsed.events[0]]);
  assert.equal(second.parsed.later?.length, 1, second.r.text);
  assert.equal(second.parsed.notice, undefined);
  assert.equal(second.r.session, undefined);
  await f.run(2, [first.parsed.events[0]]);
  let timer = second.parsed.later[0];
  const due = (n, timer) =>
    f.run(n, [{ type: "timer.due", id: "timer:" + n, subject: f.subject }], { timers: [timer] });
  // An isolated reader can temporarily see a live desktop turn as interrupted.
  f.setInspect("interrupted");
  const third = await due(3, timer);
  assert.ok(third.parsed.later?.length, third.r.text);
  assert.equal(third.parsed.notice, undefined);
  const stale = await due(4, timer);
  assert.equal(stale.r.state, "not-running");
  timer = third.parsed.later[0];
  f.setInspect("completed");
  const finished = await due(5, timer);
  assert.equal(finished.parsed.notice[0].text, "建议先核对资料入口。");
  const after = await due(6, timer);
  assert.equal(after.r.state, "not-running");
  assert.deepEqual(f.calls, ["read", "plan", "queue:native-run:2", "inspect:native-run:2", "inspect:native-run:2"]);
});
test("malformed or retargeted binding cannot fall back to new visible sessions", async (t) => {
  const f = fixture(t);
  f.config.managedCodex.boundChats[f.projectKey] = null;
  const v = await f.run(1, [f.activeEvent]);
  assert.ok(v.r.errorCode);
  assert.equal(f.calls.length, 0);
  f.config.managedCodex.boundChats[f.projectKey] = {
    threadId: "primary",
    root: f.config.managedCodex.projectRoots[f.projectKey],
    projectId: "pr1",
  };
  // A binding that is present without coordinator authorization must not use the old executor.
  f.config.managedCodex.coordinatorProjectKeys = [];
  const g = await f.run(2, [f.activeEvent]);
  assert.ok(g.r.errorCode);
  assert.equal(f.calls.length, 0);
});

test("invalid ephemeral plan conserves the completed attempt and never sends a visible task", async (t) => {
  const f = fixture(t);
  f.setPlan("unusable planner output");
  const ran = await f.run(1, [f.activeEvent]);
  assert.equal(ran.r.state, "receipt-unconfirmed");
  assert.equal(ran.r.originalText, "unusable planner output");
  assert.deepEqual(ran.r.usage, { input: 16, output: 12 });
  await f.run(1, [f.activeEvent]);
  await f.run(2, [f.activeEvent]);
  assert.deepEqual(f.calls, ["read", "plan"]);
});

const chooseEntry =
  "需要你拍板：先验证哪个入口？\n1. 我的工作\n2. 卡片库\n建议选第一项，因为当天待办更能说明首页是否好用。";
const eventAnswered = (ask, n) => ({
  events: [{ type: "card.answered", id: "card:12" }],
  answers: [{ card: 12, title: ask.title, about: ask.about, options: ask.options, choice: n }],
});

test("a matched original final can ask one decision through the hub; the actual choice goes once to the original chat after an inspection", async (t) => {
  const f = fixture(t, 3);
  const first = await f.run(1, [f.activeEvent]);
  const dispatched = await f.run(2, [first.parsed.events[0]]);
  assert.match(f.queuedText[0], /需要你拍板/);
  const timer = dispatched.parsed.later[0],
    due = [{ id: "timer:1", subject: f.subject, type: "timer.due" }];
  f.setReply(chooseEntry);
  f.setInspect("completed");
  const checked = await f.run(3, due, { timers: [timer] });
  assert.equal(checked.parsed.notice, undefined);
  assert.equal(checked.parsed.later, undefined);
  const ask = checked.parsed.ask[0];
  assert.equal(ask.title, "先验证哪个入口？");
  assert.deepEqual(ask.options, ["我的工作", "卡片库"]);
  assert.equal(ask.recommend, 0);
  assert.match(ask.text, /推荐理由：当天待办/);
  assert.deepEqual((await f.run(3, due, { timers: [timer] })).parsed.ask, [ask]);
  assert.equal((await f.run(4, due, { timers: [timer] })).r.state, "not-running");
  const answer = eventAnswered(ask, 1);
  assert.equal(
    (await f.run(5, answer.events, { answers: [{ ...answer.answers[0], about: "另一目标" }] })).r.state,
    "not-running",
  );
  const accepted = await f.run(6, answer.events, { answers: answer.answers });
  assert.equal(accepted.parsed.later.length, 1);
  assert.equal(f.queuedText.length, 2);
  assert.match(f.queuedText[1], /选定了「卡片库」/);
  assert.match(f.queuedText[1], /先验证哪个入口/);
  assert.doesNotMatch(f.queuedText[1], /需要你拍板：/);
  assert.ok(!f.queuedText[1].includes("选定了「我的工作」"));
  await f.run(6, answer.events, { answers: answer.answers });
  assert.equal(f.queuedText.length, 2);
  assert.equal((await f.run(7, answer.events, { answers: answer.answers })).r.state, "not-running");
  f.setReply("从卡片库选一张卡，先看到最近使用的示例。");
  const final = await f.run(8, [{ ...due[0], id: "timer:2" }], { timers: accepted.parsed.later });
  assert.equal(final.parsed.notice[0].text, "从卡片库选一张卡，先看到最近使用的示例。");
});

test("questions mentioned in narrative, malformed recommendations and exhausted budgets stay ordinary notices", async (t) => {
  const examples = [
    "已完成。还有其它想法吗？",
    "历史上有人写过：\n" + chooseEntry,
    chooseEntry
      .split("\n")
      .map((s) => "> " + s)
      .join("\n"),
    chooseEntry.replace("第一项", "第 3 项"),
    chooseEntry.replace("2. 卡片库", "3. 卡片库"),
    chooseEntry.replace("2. 卡片库", "2. 我的工作"),
    chooseEntry.replace("，因为当天待办更能说明首页是否好用。", "。"),
    chooseEntry + "\n附：并未决定发起上述选择。",
  ];
  for (const [i, body] of [...examples, chooseEntry].entries()) {
    const f = fixture(t, i === examples.length ? 2 : 3);
    const first = await f.run(1, [f.activeEvent]);
    f.setQueue("completed");
    f.setReply(body);
    const got = await f.run(2, [first.parsed.events[0]]);
    assert.equal(got.parsed.ask, undefined);
    assert.equal(got.parsed.notice[0].text, body);
  }
});
