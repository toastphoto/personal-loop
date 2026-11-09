// A coordinator must not invent the project's next task or accept a report not acknowledged by its original chat.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProjectReport, projectReportAction, reporterPrompt, parseReporterSummary } from "./project-report.mjs";
import { runBoundStage } from "./bound-coordination.mjs";
const proposal = {
  schemaVersion: 1,
  updatedAt: "2026-11-09T10:00:00+08:00",
  projectGoal: "完整App导航与第一步",
  diagnosis: "支线过细，应回完整主线",
  evidence: ["docs/project_memory/COORDINATOR_BRIEF.md"],
  action: "dispatch",
  progress: "已有可复用的草稿检查",
  nextStep: "恢复项目首页到资料、对话和成果的连续入口",
  expectedResult: "可点击整个主线并标出未接通项",
};
function fixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "project-led-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, "docs/project_memory"), { recursive: true });
  const file = path.join(cwd, "docs/project_memory/PROJECT_REPORT.json");
  const bytes = JSON.stringify(proposal);
  writeFileSync(file, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    cwd,
    file,
    sha256,
    primary: {
      phase: "final_answer",
      complete: true,
      truncated: false,
      excerpt: "项目判断已完成。PROJECT_REPORT_SHA256: " + sha256,
    },
  };
}
test("only an exact report acknowledged by the latest original final reply can choose the next step", (t) => {
  const f = fixture(t);
  const r = readProjectReport(f);
  assert.equal(r.status, "verified");
  assert.deepEqual(projectReportAction(r, { role: "router" }), {
    action: "dispatch",
    progress: proposal.progress,
    nextStep: proposal.nextStep,
    expectedResult: proposal.expectedResult,
  });
  writeFileSync(f.file, JSON.stringify({ ...proposal, nextStep: "偏离原报告的工作" }));
  assert.equal(readProjectReport(f).status, "unacknowledged");
  assert.equal(readProjectReport({ ...f, primary: { ...f.primary, phase: "commentary" } }).status, "unacknowledged");
});
test("missing or stale reports ask the project to report, never let the central model make a technical plan", (t) => {
  const f = fixture(t);
  rmSync(f.file);
  const r = readProjectReport(f);
  assert.equal(r.status, "missing");
  assert.match(projectReportAction(r, { role: "router" }).nextStep, /项目主责/);
  const prompt = reporterPrompt({ report: r, goal: { objective: "继续原目标" } });
  assert.match(prompt, /不得设计下一步/);
  assert.throws(() => parseReporterSummary('{"summary":"报告","nextStep":"重做画布"}', "a".repeat(64)));
});
test("reporter cannot substitute a different report and cannot cross the project root", (t) => {
  const f = fixture(t);
  assert.equal(
    parseReporterSummary(JSON.stringify({ summary: "已有成果，项目提出下一步", reportSha256: f.sha256 }), f.sha256),
    "已有成果，项目提出下一步",
  );
  assert.throws(() =>
    parseReporterSummary(JSON.stringify({ summary: "已有成果", reportSha256: "b".repeat(64) }), f.sha256),
  );
  rmSync(f.file);
  symlinkSync(path.join(f.cwd, "other.json"), f.file);
  writeFileSync(path.join(f.cwd, "other.json"), JSON.stringify(proposal));
  assert.notEqual(readProjectReport(f).status, "verified");
});
test("an owner answer returns to the project for judgment instead of reusing the previous ask", (t) => {
  const f = fixture(t);
  const r = readProjectReport(f);
  const action = projectReportAction(r, { role: "router", freshAnswer: true, answerText: "优先完整主线" });
  assert.match(action.nextStep, /本人/);
  assert.notEqual(action.nextStep, proposal.nextStep);
});

test("the bound pipeline reports temporarily and dispatches the exact project proposal to the same original", async (t) => {
  const f = fixture(t),
    projectKey = "codex:local:pr1",
    threadId = "original";
  let queued;
  const args = {
    config: {
      providers: { codex: { allowConversationPreview: true } },
      managedCodex: { coordinationMode: "project-led", command: "/fixture/codex" },
    },
    binding: { threadId },
    catalog: {},
    projectKey,
    projectId: "pr1",
    cwd: f.cwd,
    stage: { role: "router" },
    goal: { objective: "继续完整App主线", maxSteps: null },
    goalId: "goal",
    runId: "one",
    executionKey: "one",
    subject: "subject",
    remaining: 10,
    file: path.join(f.cwd, "snapshot.json"),
    guard() {},
  };
  const read = await runBoundStage(args, {
    readBoundProgress: async () => f.primary,
    runEphemeralCoordinator: async ({ prompt }) => {
      assert.match(prompt, /临时汇报员/);
      assert.doesNotMatch(prompt, /决定对目标最有用的一步/);
      return { text: JSON.stringify({ summary: "项目建议回到完整App主线", reportSha256: f.sha256 }) };
    },
  });
  assert.equal(read.coordinator.plan.nextStep, proposal.nextStep);
  assert.equal(read.coordinator.projectLed, true);
  await runBoundStage(
    {
      ...args,
      runId: "two",
      executionKey: "two",
      stage: {
        role: "worker",
        projectLed: true,
        reportSha256: f.sha256,
        initialHandoff: true,
        plan: read.coordinator.plan,
      },
    },
    {
      queueBoundChat: async ({ text }) => {
        queued = text;
        return { status: "queued", threadId };
      },
    },
  );
  assert.match(queued, /项目报告/);
  assert(queued.includes(proposal.nextStep));
  assert(queued.includes(proposal.expectedResult));
  const migrated = await runBoundStage(
    {
      ...args,
      file: path.join(f.cwd, "migration.json"),
      stage: { role: "worker", plan: { nextStep: "旧中央规划器编写的任务", expectedResult: "旧任务" } },
    },
    {
      readBoundProgress: async () => f.primary,
      runEphemeralCoordinator: async () => ({
        text: JSON.stringify({ summary: "沿项目自己的安排继续", reportSha256: f.sha256 }),
      }),
      queueBoundChat: async () => {
        throw Error("must not dispatch old plan");
      },
    },
  );
  assert.equal(migrated.coordinator.plan.nextStep, proposal.nextStep);
  await assert.rejects(
    runBoundStage(
      { ...args, file: path.join(f.cwd, "bad-snapshot.json") },
      {
        readBoundProgress: async () => f.primary,
        runEphemeralCoordinator: async () => ({
          text: JSON.stringify({ summary: "另做权限矩阵", reportSha256: f.sha256, nextStep: "重写全部模块" }),
        }),
      },
    ),
    { code: "PROJECT_REPORTER_INVALID" },
  );
  writeFileSync(f.file, JSON.stringify({ ...proposal, nextStep: "项目刚刚改变了安排" }));
  await assert.rejects(
    runBoundStage(
      { ...args, stage: { role: "worker", projectLed: true, reportSha256: f.sha256, plan: read.coordinator.plan } },
      {
        queueBoundChat: async () => {
          throw Error("must not send stale report");
        },
      },
    ),
    { code: "PROJECT_REPORT_CHANGED" },
  );
});

test("an ended multi-input turn moves to project report review without claiming the old single task succeeded", async (t) => {
  const f = fixture(t),
    plan = { nextStep: "旧任务", expectedResult: "旧标准" };
  const r = await runBoundStage(
    {
      config: { managedCodex: { coordinationMode: "project-led" } },
      cwd: f.cwd,
      binding: { threadId: "original" },
      projectKey: "codex:local:p",
      stage: {
        role: "bound-observe",
        plan,
        handoff: {
          threadId: "original",
          requestId: "old",
          text: "旧任务",
          plan,
          checks: 1000,
          submittedAt: Date.now() - 3600000,
        },
      },
      goal: { maxSteps: null },
      goalId: "goal",
      runId: "review",
      remaining: 100,
      guard() {},
    },
    {
      inspectBoundChat: async () => ({
        threadId: "original",
        turnId: "ended",
        status: "in-thread",
        code: "BOUND_AMBIGUOUS_TURN",
        nativeCompleted: true,
      }),
    },
  );
  assert.equal(r.coordinator.action, "review-progress");
  assert.equal(r.coordinator.completedStepFingerprint, undefined);
  assert.match(r.coordinator.reply, /归属/);
});

test("project-authored choices survive reporting and the actual owner answer returns to the same project", async (t) => {
  const f = fixture(t),
    question = {
      ...proposal,
      action: "ask",
      question: "先交付哪个完整闭环？",
      options: ["完整项目工作桌", "先补团队共享"],
      recommend: 0,
      reason: "现有主App已具备大部分能力",
    };
  const bytes = JSON.stringify(question),
    sha = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(f.file, bytes);
  const args = {
    config: {
      providers: { codex: { allowConversationPreview: true } },
      managedCodex: { coordinationMode: "project-led", command: "/fixture/codex" },
    },
    binding: { threadId: "original" },
    catalog: {},
    projectKey: "codex:local:p",
    projectId: "p",
    cwd: f.cwd,
    stage: { role: "router" },
    goal: { objective: "完成App主线", maxSteps: null },
    goalId: "g",
    runId: "choice",
    executionKey: "choice",
    subject: "subject",
    remaining: 100,
    file: path.join(f.cwd, "choice.json"),
    guard() {},
  };
  const result = await runBoundStage(args, {
    readBoundProgress: async () => ({ ...f.primary, excerpt: "PROJECT_REPORT_SHA256: " + sha }),
    runEphemeralCoordinator: async () => ({
      text: JSON.stringify({ summary: "项目需要本人确定交付先后", reportSha256: sha }),
    }),
  });
  assert.deepEqual(result.coordinator.ask.options, question.options);
  assert.equal(result.coordinator.ask.recommend, 0);
  assert(result.coordinator.ask.text.includes(question.reason));
  let text;
  await runBoundStage(
    {
      ...args,
      runId: "answer",
      executionKey: "answer",
      stage: {
        role: "worker",
        plan: result.coordinator.plan,
        freshAnswer: true,
        chosen: question.options[0],
        chosenQuestion: question.question,
        answerText: "先把主线做顺，保留已有成果",
        answerCard: 7,
      },
    },
    {
      queueBoundChat: async (a) => {
        a.beforeMutation();
        text = a.text;
        return { status: "queued", threadId: "original" };
      },
    },
  );
  assert(text.includes("先把主线做顺，保留已有成果"));
  assert(text.includes(question.options[0]));
  assert.match(text, /结合本人这次真实回答/);
  assert.doesNotMatch(text, /资源已经具备。现在直接/);
});
