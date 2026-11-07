// A new/replaced goal cannot inherit a previous click. The model never chooses the event target.
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureProgress, coordinatorStage, coordinatedResult } from "./coordinated-work.mjs";
import { subjectFor } from "./controls.mjs";
const key = "codex:local:demo",
  subject = subjectFor(key),
  kind = "native.project." + subject.slice(0, 32);
const ctx = (events, answers = [], timers = []) => ({ events, answers, timers });
const plan = {
  action: "ask",
  progress: "资料齐全",
  nextStep: "核对所选方向",
  expectedResult: "三条检查项",
  question: "先检查哪项？",
  options: ["入口", "流程"],
  recommend: 0,
  reason: "入口涉及全部试用人员",
};
const goal = { projectKey: key, goalRevision: 3, revision: 3, goalStartEvent: "activation" };
const args = { goal, goalId: "goal-v3", runId: "7", remaining: 2, history: [], subject };
test("router compiles one recommendation and only its actual answer wakes a distinct worker", () => {
  const row = coordinatedResult(JSON.stringify(plan), { ...args, stage: { role: "router" } });
  const ask = JSON.parse(row.text.split("```agent-autoloop\n")[1].split("\n```")[0]).ask[0];
  assert.equal(ask.recommend, 0);
  assert.ok(ask.text.endsWith("推荐理由：" + plan.reason));
  const context = ctx(
    [{ id: "card:12", type: "card.answered" }],
    [{ card: 12, title: ask.title, options: ask.options, choice: 1, about: ask.about }],
  );
  const history = [row.coordinator];
  assert.equal(coordinatorStage({ ...args, history, context }).chosen, "流程");
  assert.equal(
    coordinatorStage({
      ...args,
      history,
      context: { ...context, answers: [{ ...context.answers[0], about: "other goal" }] },
    }),
    null,
  );
  assert.equal(
    coordinatorStage({ ...args, history, context: ctx([{ id: "card:9", type: "card.answered" }], context.answers) }),
    null,
  );
});
test("handoffs are created by the wrapper and only the exact persisted handoff can wake the worker", () => {
  const { progress, nextStep, expectedResult } = plan;
  const row = coordinatedResult(JSON.stringify({ action: "dispatch", progress, nextStep, expectedResult }), {
    ...args,
    stage: { role: "router" },
  });
  const event = JSON.parse(row.text.split("```agent-autoloop\n")[1].split("\n```")[0]).events[0];
  assert.equal(event.subject, subject);
  assert.equal(event.type, kind + ".handoff");
  assert.equal(event.id, "handoff-7");
  const history = [row.coordinator];
  assert.equal(coordinatorStage({ ...args, history, context: ctx([event]) }).role, "worker");
  assert.equal(coordinatorStage({ ...args, history, context: ctx([{ ...event, id: "wrong" }]) }), null);
  const done = coordinatedResult(
    JSON.stringify({ action: "deliver", summary: "核对完毕", deliverable: "1. 入口清晰\n2. 步骤可回退" }),
    { ...args, runId: "8", stage: { role: "worker" }, history },
  );
  assert.match(done.text, /步骤可回退/);
  assert.equal(coordinatorStage({ ...args, history: [...history, done.coordinator], context: ctx([event]) }), null);
  assert.throws(() =>
    coordinatedResult(JSON.stringify({ ...plan, events: [event] }), { ...args, stage: { role: "router" } }),
  );
});

test("choosing once carries the choice through a real review and blocks a second question", () => {
  const router = coordinatedResult(JSON.stringify(plan), { ...args, stage: { role: "router" } }).coordinator;
  const stage = { role: "worker", plan: router.plan, chosen: "入口" };
  const at = new Date(Date.now() + 60_000).toISOString();
  assert.throws(() => coordinatedResult(JSON.stringify(plan), { ...args, stage }));
  const review = coordinatedResult(
    JSON.stringify({ action: "review", summary: "正在等试用结果", about: "核对试用回执", at }),
    { ...args, runId: "8", stage },
  ).coordinator;
  const context = ctx([{ type: "timer.due" }], [], [review.timer]);
  const history = [router, review];
  assert.deepEqual(coordinatorStage({ ...args, history, context }), { ...stage, review: review.timer.about });
  assert.equal(
    coordinatorStage({ ...args, history, context: { ...context, timers: [{ ...review.timer, key: "other" }] } }),
    null,
  );
  assert.throws(() =>
    coordinatedResult(JSON.stringify({ action: "review", summary: "等试用", about: "回执", at }), {
      ...args,
      remaining: 0,
      stage,
    }),
  );
});
test("startup requires a real activation of the selected generation, not a stale answer or another project", () => {
  const activate = { type: kind + ".changed", id: "activation", subject };
  const decide = (e) => coordinatorStage({ ...args, context: ctx([e]) });
  assert.deepEqual(decide(activate), { role: "router" });
  for (const e of [
    { ...activate, id: "previous" },
    { ...activate, subject: "other" },
    { ...activate, type: "card.answered" },
  ])
    assert.equal(decide(e), null);
});
test("the private planning snapshot uses only approved project files and avoids links outside the project", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "coord-progress-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "project"),
    destination = path.join(dir, "snapshot.json");
  mkdirSync(path.join(cwd, "docs", "project_memory"), { recursive: true });
  writeFileSync(
    path.join(cwd, "docs", "project_memory", "ACTIVE_CONTEXT.md"),
    "员工试用方案尚待选择。" + "x".repeat(6800),
  );
  writeFileSync(path.join(dir, "foreign.md"), "OUTSIDE-MARKER");
  symlinkSync(path.join(dir, "foreign.md"), path.join(cwd, "AGENTS.md"));
  const evidence = await captureProgress({ cwd, destination, projectKey: key, config: {}, catalog: null });
  assert.equal(evidence.documentCount, 1);
  assert.equal(evidence.nativeStatus, "preview-disabled");
  const saved = JSON.parse(readFileSync(destination, "utf8"));
  assert.equal(saved.documents[0].truncated, true);
  assert.match(saved.documents[0].text, /员工试用方案/);
  assert.doesNotMatch(JSON.stringify(saved), /OUTSIDE-MARKER/);
  await assert.rejects(captureProgress({ cwd, destination, projectKey: key, config: {}, catalog: null }), {
    code: "EEXIST",
  });
});

test("continuous work reviews a real completed step, then advances or finishes without forcing a human choice", () => {
  const goal = { objective: "做好导航", maxSteps: null };
  const before = {
    role: "worker",
    action: "review-progress",
    runId: "8",
    plan: { progress: "已有入口", nextStep: "核对导航", expectedResult: "说明" },
    reply: "导航已整理，还缺每页首件事",
    handoff: {},
    turnId: "exact",
  };
  const context = ctx([{ type: kind + ".handoff", id: "review-8", subject }]);
  const stage = coordinatorStage({ ...args, goal, history: [before], context });
  assert.equal(stage.role, "router-review");
  assert.equal(stage.reply, before.reply);
  const next = coordinatedResult(
    JSON.stringify({
      action: "dispatch",
      progress: "已核导航",
      nextStep: "补齐每页首件事",
      expectedResult: "每页一条",
    }),
    { ...args, stage, remaining: Infinity },
  ).coordinator;
  assert.equal(next.action, "dispatch");
  const selected = { ...stage, chosen: "方案乙" };
  const continued = coordinatedResult(
    JSON.stringify({
      action: "dispatch",
      progress: "已核导航",
      nextStep: "补齐页面首件事",
      expectedResult: "逐页说明",
    }),
    { ...args, stage: selected, remaining: Infinity },
  ).coordinator;
  const resumed = coordinatorStage({
    ...args,
    goal,
    history: [before, continued],
    context: ctx([{ type: kind + ".handoff", id: "handoff-" + continued.runId, subject }]),
  });
  assert.equal(resumed.chosen, "方案乙");
  assert.throws(() =>
    coordinatedResult(JSON.stringify({ action: "dispatch", ...before.plan }), { ...args, stage, remaining: Infinity }),
  );
  const finish = coordinatedResult(
    JSON.stringify({ action: "finish", summary: "每页首件事已核齐", reason: "导航7项和各自操作都有说明" }),
    { ...args, stage, remaining: Infinity },
  );
  assert.equal(finish.coordinator.action, "finish");
  const ended = JSON.parse(
    finish.text.split("~~~")[0].match(/\x60\x60\x60agent-autoloop\n([\s\S]*?)\n\x60\x60\x60/)[1],
  );
  assert.equal(ended.events, undefined);
  assert.equal(ended.later, undefined);
  assert.ok(ended.notice[0].text.includes("7项"));
  assert.equal(
    coordinatorStage({
      ...args,
      goal,
      history: [before],
      context: ctx([{ type: kind + ".handoff", id: "wrong", subject }]),
    }),
    null,
  );
});

test("continuous worker decisions keep earlier choices and reject duplicated questions while finite budgets retain their old rule", () => {
  const remembered = { question: "先做哪项？", options: ["入口", "流程"], chosen: "流程" };
  const stage = {
    role: "worker",
    plan: { nextStep: "验证入口" },
    chosen: "流程",
    chosenQuestion: remembered.question,
    decisions: [remembered],
  };
  const different = { ...plan, question: "先验哪类设备？", options: ["桌面", "手机"], nextStep: "核对设备适配" };
  const out = coordinatedResult(JSON.stringify(different), { ...args, stage, remaining: Infinity, untilDone: true });
  assert.deepEqual(out.coordinator.decisions, [remembered]);
  assert.equal(out.coordinator.ask.title, different.question);
  assert.throws(() =>
    coordinatedResult(
      JSON.stringify({ ...different, question: remembered.question, options: [...remembered.options].reverse() }),
      { ...args, stage, remaining: Infinity, untilDone: true },
    ),
  );
  assert.throws(() => coordinatedResult(JSON.stringify(different), { ...args, stage, remaining: 2 }));
});
