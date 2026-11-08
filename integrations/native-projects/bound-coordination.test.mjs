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
  let planOverride, afterQueue, afterPlan, afterClose;
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
          async close() {
            afterClose?.();
          },
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
          afterPlan?.();
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
          afterQueue?.();
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
    afterQueue: (fn) => (afterQueue = fn),
    afterPlan: (fn) => (afterPlan = fn),
    afterClose: (fn) => (afterClose = fn),
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

const missingMaterial =
  "需要你协助：用哪份样例核对员工入口？\n已核对：现有资料只有旧样例，正式版入口尚不能验收。\n1. 我已补好正式样例，重新核实\n2. 先用旧样例列待补项\n建议选第二项，因为能先完成不依赖正式样例的部分。";
test("a confirmed need for owner help sends a scoped actionable question; choosing to supply material leads to re-verification", async (t) => {
  const f = fixture(t, 3);
  const router = await f.run(1, [f.activeEvent]);
  f.setQueue("completed");
  f.setReply(missingMaterial);
  const stopped = await f.run(2, [router.parsed.events[0]]);
  const ask = stopped.parsed.ask?.[0];
  assert.ok(ask, "material blockers must not silently become a completed deliverable");
  assert.match(ask.text, /现有资料只有旧样例/);
  assert.equal(ask.recommend, 1);
  assert.deepEqual(ask.options, ["我已补好正式样例，重新核实", "先用旧样例列待补项"]);
  assert.equal(stopped.parsed.later, undefined);
  assert.deepEqual((await f.run(2, [router.parsed.events[0]])).parsed.ask, [ask]);
  const answer = eventAnswered(ask, 0);
  f.setReply("已在原资料中重新核对该项。");
  const resumed = await f.run(3, answer.events, { answers: answer.answers });
  assert.equal(resumed.parsed.notice[0].text, "已在原资料中重新核对该项。");
  assert.match(f.queuedText[1], /我已补好正式样例，重新核实/);
  assert.match(f.queuedText[1], /重新核实|重新核对/);
  assert.match(f.queuedText[1], /不代表|不等于/);
});

test("a confirmed missing input offers a recheck only with continuation budget", async (t) => {
  for (const [budget, reply] of [
    [2, missingMaterial],
    [3, "需要你协助：请在原对话补一份脱敏样例。\n已核对：当前资料没有样例，无法验证表单。"],
  ]) {
    const f = fixture(t, budget);
    const first = await f.run(1, [f.activeEvent]);
    f.setQueue("completed");
    f.setReply(reply);
    const result = await f.run(2, [first.parsed.events[0]]);
    if (budget === 3) {
      const ask = result.parsed.ask[0];
      assert.deepEqual(ask.options, ["我已处理，重新核实", "先暂停此目标"]);
      assert.match(ask.text, /先处理/);
      assert.equal(result.parsed.notice, undefined);
      continue;
    }
    assert.equal(result.parsed.ask, undefined);
    assert.equal(result.r.coordinator.action, "attention");
    assert.match(result.parsed.notice[0].title, /协助/);
    assert.match(result.parsed.notice[0].text, /样例/);
    assert.doesNotMatch(result.parsed.notice[0].text, /已完成|马上自动/);
  }
});

test("repeated lost verification asks the owner to check once without treating an ordinary wait as a blocker", async () => {
  const { runBoundStage } = await import("./bound-coordination.mjs");
  const started = Date.now() - 15 * 60000;
  const threadId = "original";
  const observed = async (handoff, status, code) =>
    runBoundStage(
      {
        stage: { role: "bound-observe", handoff },
        goal: {},
        binding: { threadId },
        runId: "7",
        remaining: 1,
        guard() {},
      },
      { inspectBoundChat: async () => ({ threadId, status, code }) },
    );
  const handoff = {
    threadId,
    submittedAt: started,
    requestId: "native-run:6",
    text: "核对导航",
    checks: 2,
    uncertainSince: started,
    uncertainCount: 2,
  };
  const receipt = (r) => resultFrom(readMessage(r.text), {}).result;
  const wait = await observed(handoff, "queued");
  assert.equal(receipt(wait).notice, undefined);
  const transient = await observed({ ...handoff, uncertainSince: Date.now() }, "unknown", "BOUND_UNVERIFIED");
  assert.equal(receipt(transient).notice, undefined);
  const help = await observed(handoff, "unknown", "BOUND_UNVERIFIED");
  assert.equal(receipt(help).notice.length, 1);
  assert.equal(receipt(help).later.length, 1);
  assert.match(receipt(help).notice[0].text, /不用重发/);
  const next = await observed(help.coordinator.handoff, "unknown", "BOUND_UNVERIFIED");
  assert.equal(receipt(next).notice, undefined);
  const changed = await observed(handoff, "unknown", "BOUND_SCOPE_MISMATCH");
  assert.equal(changed.coordinator.action, "attention");
  assert.equal(receipt(changed).later, undefined);
});

test("default continuous work can progress beyond three turns, then ends only on verified goal completion", async (t) => {
  const f = fixture(t, null);
  const initial = await f.run(1, [f.activeEvent]);
  f.setQueue("completed");
  f.setReply("入口已核对，需要补齐实际页面验收说明");
  const next = (n, result) => f.run(n, [{ type: "timer.due", subject: f.subject }], { timers: result.parsed.later });
  const completedStep = await next(2, initial);
  assert.equal(completedStep.r.coordinator.action, "review-progress");
  assert.equal(completedStep.parsed.notice, undefined);
  f.setPlan(
    JSON.stringify({
      action: "dispatch",
      progress: "入口已核对",
      nextStep: "验证入口的验收说明",
      expectedResult: "首件事清单",
    }),
  );
  const review = await next(3, completedStep);
  assert.equal(review.r.coordinator.action, "dispatch");
  f.setReply("验收说明和各页面首件事清单已核齐");
  const nextStep = await next(4, review);
  assert.equal(nextStep.r.coordinator.action, "review-progress");
  f.setPlan(
    JSON.stringify({
      action: "finish",
      summary: "导航及页面首件事已核齐",
      reason: "当前目标的入口清单和验收说明都有了",
    }),
  );
  const final = await next(5, nextStep);
  assert.equal(final.r.coordinator.action, "finish");
  assert.equal(final.parsed.events, undefined);
  assert.equal(final.parsed.later, undefined);
  assert.equal(final.parsed.notice.length, 1);
  const repeat = await f.run(6, [f.activeEvent]);
  assert.equal(repeat.r.state, "not-running");
  assert.equal(f.queuedText.length, 2);
});

test("a paused completed step is reviewed after an explicit same-goal resume instead of being dispatched again", async (t) => {
  const f = fixture(t, null);
  const next = (id, result) => f.run(id, [{ type: "timer.due", subject: f.subject }], { timers: result.parsed.later });
  const start = await f.run(1, [f.activeEvent]);
  f.setQueue("completed");
  f.setReply("本轮入口已经核对完成。");
  f.afterQueue(() => f.controls.set(f.projectKey, "paused", { actor: "owner", requestId: "pause-completion" }));
  const paused = await next(2, start);
  assert.equal(paused.r.coordinator.action, "suspended");
  assert.equal(paused.parsed.later, undefined);
  assert.equal(paused.r.coordinator.reply, "本轮入口已经核对完成。");
  f.afterQueue(null);
  const resume = f.controls.set(f.projectKey, "active", { actor: "owner", requestId: "resume-completion" });
  f.setPlan(JSON.stringify({ action: "finish", summary: "目标已经完成", reason: "已确认的入口清单全部齐全" }));
  const finish = await f.run(3, [{ type: f.prefix + ".changed", subject: f.subject, id: resume.goalControlEvent }]);
  assert.equal(finish.r.coordinator.action, "finish");
  assert.equal(f.queuedText.length, 1);
  assert.equal(f.controls.get(f.projectKey).goalRevision, f.goal.goalRevision);
});

test("continuous plans reject repeating an older completed step even if punctuation or acceptance prose changes", async (t) => {
  const f = fixture(t, null);
  const next = (id, result) => f.run(id, [{ type: "timer.due", subject: f.subject }], { timers: result.parsed.later });
  let r = await f.run(1, [f.activeEvent]);
  f.setQueue("completed");
  f.setReply("入口步骤A已完成。");
  r = await next(2, r);
  f.setPlan(
    JSON.stringify({
      action: "dispatch",
      progress: "继续下一项",
      nextStep: "验证入口的验收说明",
      expectedResult: "步骤B",
    }),
  );
  r = await next(3, r);
  f.setReply("入口步骤B已完成。");
  r = await next(4, r);
  f.setPlan(
    JSON.stringify({
      action: "dispatch",
      progress: "再试第一项",
      nextStep: "验证入口 与 界面关系。",
      expectedResult: "换个验收措辞",
    }),
  );
  r = await next(5, r);
  assert.equal(r.r.state, "receipt-unconfirmed");
  assert.equal(r.parsed.events, undefined);
  assert.equal(r.parsed.later, undefined);
  assert.equal(f.queuedText.length, 2);
});

test("a pause while closing the catalogue suppresses continuation but keeps the completed reply for resume", async (t) => {
  const f = fixture(t, null);
  const start = await f.run(1, [f.activeEvent]);
  f.setQueue("completed");
  f.setReply("入口及验收结果已完成。");
  f.afterClose(() => f.controls.set(f.projectKey, "paused", { actor: "owner", requestId: "pause-on-close" }));
  const held = await f.run(2, [{ type: "timer.due" }], { timers: start.parsed.later });
  assert.equal(held.r.coordinator.action, "suspended");
  assert.equal(held.parsed.later, undefined);
  assert.equal(held.r.coordinator.reply, "入口及验收结果已完成。");
  f.afterClose(null);
  const resumed = f.controls.set(f.projectKey, "active", { actor: "owner", requestId: "resume-on-close" });
  f.setPlan(JSON.stringify({ action: "finish", summary: "目标已达到", reason: "入口和验收结果齐全" }));
  const finished = await f.run(3, [{ type: f.prefix + ".changed", subject: f.subject, id: resumed.goalControlEvent }]);
  assert.equal(finished.r.coordinator.action, "finish");
  assert.equal(f.queuedText.length, 1);
});

test("a pause during review keeps its actual source instead of blindly sending the proposed next step", async (t) => {
  const f = fixture(t, null);
  const next = (id, result) => f.run(id, [{ type: "timer.due" }], { timers: result.parsed.later });
  let r = await f.run(1, [f.activeEvent]);
  f.setQueue("completed");
  f.setReply("第一项入口已经完成。");
  r = await next(2, r);
  f.setPlan(
    JSON.stringify({
      action: "dispatch",
      progress: "第一项已完成",
      nextStep: "验证入口的另一份材料",
      expectedResult: "第二项结论",
    }),
  );
  f.afterPlan(() => f.controls.set(f.projectKey, "paused", { actor: "owner", requestId: "pause-review" }));
  r = await next(3, r);
  assert.equal(r.r.coordinator.action, "suspended");
  assert.equal(r.parsed.later, undefined);
  assert.equal(r.r.coordinator.reviewSource.reply, "第一项入口已经完成。");
  f.afterPlan(null);
  const resumed = f.controls.set(f.projectKey, "active", { actor: "owner", requestId: "resume-review" });
  r = await f.run(4, [{ type: f.prefix + ".changed", subject: f.subject, id: resumed.goalControlEvent }]);
  assert.equal(r.r.coordinator.action, "dispatch");
  assert.equal(f.queuedText.length, 1, "resuming re-evaluates before queueing");
  r = await next(5, r);
  assert.equal(r.r.coordinator.action, "review-progress");
  assert.equal(f.queuedText.length, 2);
});

test("a different generation cannot resume the paused result of a previous objective", async (t) => {
  const f = fixture(t, null);
  const r = await f.run(1, [f.activeEvent]);
  f.setQueue("completed");
  f.afterQueue(() => f.controls.set(f.projectKey, "paused", { actor: "owner" }));
  const ended = await f.run(2, [{ type: "timer.due", subject: f.subject }], { timers: r.parsed.later });
  assert.equal(ended.r.coordinator.action, "suspended");
  f.afterQueue(null);
  f.controls.set(f.projectKey, "active", {
    actor: "owner",
    objective: "完全不同的新目标",
    maxSteps: null,
    requestId: "another-goal",
  });
  const old = await f.run(3, [{ type: "timer.due", subject: f.subject }], { timers: r.parsed.later });
  assert.equal(old.r.state, "not-running");
  assert.equal(f.queuedText.length, 1);
});

test("continuous work keeps decision A across several steps, accepts a different decision B, and never asks A again", async (t) => {
  const f = fixture(t, null);
  f.setQueue("completed");
  const A = {
    action: "ask",
    progress: "需要确定首个验收重点",
    nextStep: "验证入口第一部分",
    expectedResult: "核对记录",
    question: "首轮先看什么？",
    options: ["入口", "流程"],
    recommend: 0,
    reason: "入口更容易核对",
  };
  const B = "需要你拍板：先验哪类设备？\n1. 桌面端\n2. 移动端\n建议选第 1 项，因为现有同事用桌面更多。";
  const answer = (ask, n, id) => ({
    events: [{ type: "card.answered", id: "card:" + id }],
    answers: [{ card: id, title: ask.title, about: ask.about, options: ask.options, choice: n }],
  });
  const next = async (num, prior) => f.run(num, [{ type: "timer.due" }], { timers: prior.parsed.later });
  f.setPlan(JSON.stringify(A));
  const first = await f.run(1, [f.activeEvent]);
  const chosenA = answer(first.parsed.ask[0], 1, 11);
  f.setReply("第一部分已完成。");
  const doneA = await f.run(2, chosenA.events, { answers: chosenA.answers });
  assert.deepEqual(doneA.r.coordinator.decisions, [{ question: A.question, options: A.options, chosen: "流程" }]);
  f.setPlan(
    JSON.stringify({
      action: "dispatch",
      progress: "第一部分有结果",
      nextStep: "验证入口第二部分",
      expectedResult: "第二份核对",
    }),
  );
  const plan2 = await next(3, doneA);
  f.setReply(B);
  const second = await next(4, plan2);
  assert.equal(second.parsed.ask.length, 1, "a previous chosen branch must not disable the next genuine decision");
  assert.match(f.queuedText[1], /首轮先看什么.*流程/);
  const askB = second.parsed.ask[0],
    chosenB = answer(askB, 1, 12);
  const forged = await f.run(5, chosenB.events, { answers: [{ ...chosenB.answers[0], about: "foreign-generation" }] });
  assert.equal(forged.r.state, "not-running");
  assert.equal(f.queuedText.length, 2);
  f.setReply("第二部分已按移动端核对。");
  const doneB = await f.run(6, chosenB.events, { answers: chosenB.answers });
  assert.deepEqual(doneB.r.coordinator.decisions, [
    { question: A.question, options: A.options, chosen: "流程" },
    { question: "先验哪类设备？", options: ["桌面端", "移动端"], chosen: "移动端" },
  ]);
  assert.match(f.queuedText[2], /首轮先看什么.*流程/);
  assert.match(f.queuedText[2], /先验哪类设备.*移动端/);
  f.setPlan(
    JSON.stringify({
      action: "dispatch",
      progress: "已有两份核对",
      nextStep: "验证入口第三部分",
      expectedResult: "第三份说明",
    }),
  );
  const plan3 = await next(7, doneB);
  f.setReply("第三部分也已完成。");
  const done3 = await next(8, plan3);
  assert.equal(done3.r.coordinator.decisions.length, 2);
  assert.match(f.queuedText[3], /首轮先看什么.*流程/);
  assert.match(f.queuedText[3], /先验哪类设备.*移动端/);
  f.setPlan(JSON.stringify({ ...A, options: [...A.options].reverse() }));
  const repeated = await next(9, done3);
  assert.equal(repeated.r.state, "receipt-unconfirmed");
  assert.equal(repeated.parsed.ask, undefined);
  assert.equal(f.queuedText.length, 4);
});

test("continuous review retains final coverage evidence beyond the phone notice limit", async (t) => {
  const f = fixture(t, null);
  const initial = await f.run(1, [f.activeEvent]);
  f.setQueue("completed");
  const reply = "已核对入口。".repeat(350) + "结案复盘和管理后台归属也已核齐，无需新增决定。";
  f.setReply(reply);
  const step = await f.run(2, [{ type: "timer.due", subject: f.subject }], { timers: initial.parsed.later });
  assert.equal(step.r.coordinator.action, "review-progress");
  assert.equal(step.r.coordinator.reply, reply);
  assert.equal(step.parsed.notice, undefined);
});

test("owner text attached to a selection is delivered to the same original handoff", async (t) => {
  const f = fixture(t, 3);
  const first = await f.run(1, [f.activeEvent]);
  const dispatched = await f.run(2, [first.parsed.events[0]]);
  f.setReply(chooseEntry);
  f.setInspect("completed");
  const checked = await f.run(3, [{ type: "timer.due", subject: f.subject }], { timers: dispatched.parsed.later });
  const response = eventAnswered(checked.parsed.ask[0], 1);
  response.answers[0].text = "我想先看卡片库，并允许先用已有样例";
  await f.run(4, response.events, { answers: response.answers });
  assert.equal(f.queuedText.length, 2);
  assert.ok(f.queuedText[1].includes(response.answers[0].text));
});

test("a genuine free-text help answer resumes the original without claiming missing resources now exist", async (t) => {
  const f = fixture(t, 3);
  const first = await f.run(1, [f.activeEvent]);
  const dispatched = await f.run(2, [first.parsed.events[0]]);
  f.setReply("需要你协助：请补充测试环境说明\n已核对：目前只有旧记录，尚无新的入口。");
  f.setInspect("completed");
  const checked = await f.run(3, [{ type: "timer.due", subject: f.subject }], { timers: dispatched.parsed.later });
  const response = eventAnswered(checked.parsed.ask[0], null);
  response.answers[0].text = "我没有额外环境，请你先自行排查普通技术问题";
  await f.run(4, response.events, { answers: response.answers });
  assert.equal(f.queuedText.length, 2);
  assert.ok(f.queuedText[1].includes(response.answers[0].text));
  assert.doesNotMatch(f.queuedText[1], /刚刚选定了「我已处理/);
});

test("checking a queued original does not back off for minutes before noticing a finished step", async (t) => {
  const f = fixture(t, 3);
  const first = await f.run(1, [f.activeEvent]);
  const queued = await f.run(2, [first.parsed.events[0]]);
  assert.ok(Date.parse(queued.parsed.later[0].at) - Date.now() <= 60000);
  const checked = await f.run(3, [{ type: "timer.due", subject: f.subject }], { timers: queued.parsed.later });
  assert.ok(Date.parse(checked.parsed.later[0].at) - Date.now() <= 60000);
  assert.equal(f.queuedText.length, 1);
});
