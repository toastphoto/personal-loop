// An explicit binding keeps the router off the sidebar. Only the user's designated thread receives work.
import { readFileSync } from "node:fs";
import { wakeQueuedBoundChat } from "./bound-wake.mjs";
import { queueBoundChat, inspectBoundChat } from "./bound-chat.mjs";
import { readBoundProgress, runEphemeralCoordinator } from "./ephemeral-coordinator.mjs";
import {
  captureProgress,
  coordinatedPrompt,
  coordinatedResult,
  planFingerprint,
  continuationTimer,
  decisionAlreadyMade,
} from "./coordinated-work.mjs";
import { failure } from "./catalog.mjs";
import { redact } from "./project-activity.mjs";
import {
  readProjectReport,
  projectReportAction,
  reporterPrompt,
  parseReporterSummary,
  assertProjectReportUnchanged,
} from "./project-report.mjs";
const minute = 60000;
const jsonReceipt = (summary, body) =>
  summary + "\n```agent-autoloop\n" + JSON.stringify(body).replaceAll("`", "\\u0060") + "\n```";
export function boundHandoffText(goal, stage, canAsk) {
  const sentence = (text) => text.trim().replace(/[。]+$/u, "");
  const lines = [
    stage.initialHandoff
      ? (stage.projectLed ? "项目自主接续目标：" : "大肥鱼接续目标：") + goal.objective
      : stage.projectLed
        ? "项目自主推进续接"
        : "大肥鱼续办",
  ];
  if (stage.freshAnswer) {
    if (stage.answerText) lines.push("本人新补充：" + stage.answerText + "\n以这次真实回复为准，事实仍需核实。");
    if (stage.chosen && stage.chosen !== "我已处理，重新核实")
      lines.push(
        (stage.chosenQuestion ? "关于「" + stage.chosenQuestion + "」，" : "") +
          "本人本次选定了「" +
          stage.chosen +
          "」。请核实事实，选择不代表条件已具备。",
      );
    else if (stage.chosen && !stage.answerText) lines.push("本人请求重新核实缺项，尚未确认资料或权限已具备。");
  }
  lines.push(
    "本次：" + sentence(stage.plan.nextStep) + "。",
    "完成标准：" + sentence(stage.plan.expectedResult) + "。",
  );
  if (stage.initialHandoff) {
    lines.push("沿原对话已确认的范围和权限处理可逆细节，不重做已完成的工作；形成阶段成果就简短说明。");
    if (canAsk)
      lines.push(
        "确需本人取舍时，用‘需要你拍板：’提出一个问题、2–5个真实选项及一句推荐理由；只缺资料时，用‘需要你协助：’说明缺什么，并写‘已核对：’。不要替本人编造已处理的事实。",
      );
  } else lines.push("沿已确认的范围和权限推进；阶段成果简报，重大取舍再问本人。");
  if (stage.projectLed)
    lines.push(
      "具体安排来自你自己的项目报告。你负责主线和技术判断，发现偏离则自主纠正并说明。完成后更新PROJECT_REPORT.json，在最终回复开头附PROJECT_REPORT_SHA256:及文件实际SHA-256；临时汇报员只总结，不替你制定路线。",
    );
  return lines.join("\n\n");
}
// Parse one complete, current-turn decision. Quotations, examples in longer answers and ordinary questions remain prose.
function ownerRequest(text) {
  const lines = text
    .split(/\r?\n/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length < 2 || lines.length > 8 || /[`\p{Cc}\p{Cf}]/u.test(lines.join(""))) return null;
  const title = /^(需要你拍板|需要你协助)[：:]\s*(.{1,120})$/u.exec(lines[0]);
  if (!title || !title[2].trim()) return null;
  const question = title[2].trim();
  const help = title[1] === "需要你协助";
  const fact = help ? /^已核对[：:]\s*(.{1,240})$/u.exec(lines[1])?.[1]?.trim() : "";
  if (help && !fact) return null;
  const assistance = help ? { question, fact } : null;
  if (help && lines.length === 2)
    return {
      assistance,
      decision: {
        title: question,
        text: "已核对：" + fact + "\n请先处理缺项，再点重新核实。\n推荐理由：补好后可沿当前目标继续核对。",
        options: ["我已处理，重新核实", "先暂停此目标"],
        recommend: 0,
      },
    };
  const choices = lines.slice(help ? 2 : 1, -1);
  if (choices.length < 2 || choices.length > 5) return null;
  const advice = /^建议选(?:第\s*)?([1-5一二三四五])\s*(?:项)?\s*[，,]\s*因为\s*(.{1,160})$/u.exec(lines.at(-1));
  if (!advice || !advice[2].trim()) return null;
  const options = [];
  for (const entry of choices) {
    const option = /^([1-5])\s*[.．、]\s*(.{1,80})$/u.exec(entry);
    if (!option || Number(option[1]) !== options.length + 1 || !option[2].trim() || options.includes(option[2].trim()))
      return null;
    options.push(option[2].trim());
  }
  const recommend = /[1-5]/u.test(advice[1]) ? Number(advice[1]) - 1 : "一二三四五".indexOf(advice[1]);
  return recommend < options.length
    ? {
        assistance,
        decision: {
          title: question,
          options,
          recommend,
          text: (fact ? "已核对：" + fact + "\n" : "") + "推荐理由：" + advice[2].trim(),
        },
      }
    : null;
}
export async function runBoundStage(
  {
    config,
    projectKey,
    projectId,
    cwd,
    binding,
    catalog,
    stage,
    goal,
    goalId,
    runId,
    executionKey,
    subject,
    remaining,
    file,
    guard,
    signal,
  },
  deps,
) {
  guard();
  const projectLed = config?.managedCodex?.coordinationMode === "project-led";
  // A mode cutover must review an old central plan, never blindly dispatch it after resume.
  if (projectLed && stage.role === "worker" && !stage.projectLed && !stage.freshAnswer)
    stage = { ...stage, role: "router" };
  if (projectLed && stage.role === "worker" && stage.freshAnswer) {
    const answer = projectReportAction({ status: "missing" }, stage);
    stage = {
      ...stage,
      plan: { progress: answer.progress, nextStep: answer.nextStep, expectedResult: answer.expectedResult },
    };
  }
  if (stage.role === "router" || stage.role === "router-review") {
    if (config.providers?.codex?.allowConversationPreview !== true) throw failure("BOUND_PREVIEW_DISABLED");
    const primary = await (deps.readBoundProgress ?? readBoundProgress)({
      catalog,
      projectKey,
      projectId,
      cwd,
      threadId: binding.threadId,
    });
    guard();
    const evidence = await captureProgress({
      cwd,
      catalog,
      config,
      projectKey,
      destination: file,
      boundProgress: primary,
    });
    const packet = JSON.parse(readFileSync(file, "utf8"));
    if (projectLed) {
      const source = readProjectReport({ cwd, primary });
      const action = projectReportAction(source, stage);
      // Validate the project's proposal using existing scope, duplicate-step and owner-decision rules before inference.
      const parsed = coordinatedResult(JSON.stringify(action), {
        stage,
        goalId,
        runId,
        remaining,
        subject,
        untilDone: goal.maxSteps === null,
      });
      let summary, done;
      if (source.status === "verified") {
        done = await (deps.runEphemeralCoordinator ?? runEphemeralCoordinator)({
          command: config.managedCodex.command,
          prompt: reporterPrompt({ report: source, goal }),
          timeoutMs: config.managedCodex.waitTimeoutMs,
          signal,
          beforeStart: guard,
        });
        summary = parseReporterSummary(done.text, source.sha256);
        guard();
        if (readProjectReport({ cwd, primary }).sha256 !== source.sha256) throw failure("PROJECT_REPORT_CHANGED");
      }
      return {
        ...parsed,
        state: "completed",
        evidence: { ...evidence, projectReportStatus: source.status, reportSha256: source.sha256 },
        originalText: JSON.stringify(action),
        usageStatus: done?.turnUsageStatus ?? "not-reported",
        ...(done?.turnUsage && { usage: done.turnUsage }),
        coordinator: {
          ...parsed.coordinator,
          projectLed: true,
          reportSha256: source.sha256,
          reportSummary: summary,
          ...(stage.role === "router-review" && {
            reviewSource: { plan: stage.plan, reply: stage.reply, turnId: stage.previousTurn },
          }),
        },
      };
    }
    const prompt = coordinatedPrompt({ stage, goal, cwd, remaining, packet });
    const done = await (deps.runEphemeralCoordinator ?? runEphemeralCoordinator)({
      command: config.managedCodex.command,
      prompt,
      timeoutMs: config.managedCodex.waitTimeoutMs,
      signal,
      beforeStart: guard,
    });
    let parsed;
    try {
      parsed = coordinatedResult(done.text, {
        stage,
        goalId,
        runId,
        remaining,
        subject,
        untilDone: goal.maxSteps === null,
      });
    } catch (e) {
      if (e.code !== "COORDINATOR_INVALID_RESULT") throw e;
      return {
        state: "receipt-unconfirmed",
        originalText: done.text,
        evidence,
        usageStatus: done.turnUsageStatus,
        ...(done.turnUsage && { usage: done.turnUsage }),
        errorCode: e.code,
        text: jsonReceipt("大肥鱼未能确定下一步，已停止自动推进。", {
          notice: [
            {
              key: "plan-unconfirmed-" + runId,
              title: "下一步需要核对",
              text: "原对话还没有收到这次任务，规划记录已保留。",
            },
          ],
        }),
      };
    }
    return {
      ...parsed,
      ...(stage.role === "router-review" && {
        coordinator: {
          ...parsed.coordinator,
          reviewSource: { plan: stage.plan, reply: stage.reply, turnId: stage.previousTurn },
        },
      }),
      state: "completed",
      evidence,
      originalText: done.text,
      usageStatus: done.turnUsageStatus,
      ...(done.turnUsage && { usage: done.turnUsage }),
    };
  }
  const inspect = stage.role === "bound-observe";
  const dispatchGuard = () => {
    guard();
    if (projectLed && !inspect && !stage.freshAnswer && stage.reportSha256)
      assertProjectReportUnchanged(cwd, stage.reportSha256);
  };
  dispatchGuard();
  if (!inspect && !stage.answerCard && stage.completedStepHashes?.includes(planFingerprint(stage.plan)))
    throw failure("COORDINATOR_REPEATED_STEP");
  const now = Date.now();
  const canAsk = remaining > 0 && (goal.maxSteps === null || !stage.chosen);
  const handoff = inspect
    ? stage.handoff
    : {
        requestId: "native-run:" + executionKey,
        text: boundHandoffText(goal, { ...stage, projectLed }, canAsk),
        plan: stage.plan,
        ...(stage.reportSha256 && { reportSha256: stage.reportSha256 }),
        ...(stage.chosen ? { chosen: stage.chosen } : {}),
        ...(stage.chosenQuestion ? { chosenQuestion: stage.chosenQuestion } : {}),
        ...(stage.decisions?.length ? { decisions: stage.decisions } : {}),
        ...(stage.answerText ? { answerText: stage.answerText } : {}),
        canAsk,
        threadId: binding.threadId,
        checks: 0,
        submittedAt: now,
      };
  if (handoff.threadId !== binding.threadId) throw failure("BOUND_ROUTE_CHANGED");
  const fn = inspect ? (deps.inspectBoundChat ?? inspectBoundChat) : (deps.queueBoundChat ?? queueBoundChat);
  const found = await fn({
    config,
    projectKey,
    requestId: handoff.requestId,
    text: handoff.text,
    beforeMutation: dispatchGuard,
  });
  const meta = {
    role: inspect ? "bound-observe" : "worker",
    ...(stage.plan ? { plan: stage.plan } : {}),
    runId,
    threadId: binding.threadId,
    transportStatus: found.status,
    ...(stage.chosen ? { chosen: stage.chosen } : {}),
    ...(stage.chosenQuestion ? { chosenQuestion: stage.chosenQuestion } : {}),
    ...(stage.decisions?.length ? { decisions: stage.decisions } : {}),
  };
  const summary = (text, body, extra) => ({
    state: "completed",
    text: jsonReceipt(text, body),
    coordinator: { ...meta, ...extra },
    usageStatus: "not-reported",
  });
  if (
    projectLed &&
    found.threadId === binding.threadId &&
    found.turnId &&
    found.nativeCompleted === true &&
    ["BOUND_AMBIGUOUS_TURN", "BOUND_FINAL_UNCONFIRMED"].includes(found.code)
  ) {
    const timer = continuationTimer(goalId, runId, "review");
    return summary(
      "原回合已结束，按项目最新报告核对接续。",
      { later: [timer] },
      {
        action: "review-progress",
        timer,
        turnId: found.turnId,
        plan: stage.plan,
        reply:
          "旧回合已结束，但多条输入使单项任务的结果归属未能单独确认。不认定旧任务成功，不重派；下一步只依据原项目最新认可的报告，缺报告先请项目补齐。",
        attribution: "completed-turn-unattributed",
      },
    );
  }
  if (
    found.threadId === binding.threadId &&
    found.status === "completed" &&
    found.turnId &&
    typeof found.reply === "string" &&
    found.reply.trim()
  ) {
    const raw = redact(found.reply.trim()).replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,
      " ",
    );
    // An observation row does not use a model round. A genuine answer must still have budget to resume.
    const request = ownerRequest(raw);
    const hasBudget = remaining + (inspect ? 1 : 0) > 0;
    if (
      goal.maxSteps === null &&
      request?.decision &&
      decisionAlreadyMade(stage.decisions, request.decision.title, request.decision.options)
    ) {
      return summary(
        "这个问题已记录本人的选择，等待核对继续方式。",
        {
          notice: [
            {
              key: "bound-repeat-" + handoff.requestId,
              title: "原对话重复询问已决定的问题",
              text: "已有选择已保留，请核对是否出现新的条件。",
            },
          ],
        },
        { action: "attention", turnId: found.turnId },
      );
    }
    if (handoff.canAsk === true && hasBudget && request?.decision) {
      const ask = {
        ...request.decision,
        key: "bound-choice-" + handoff.requestId,
        about: "coord:" + goalId + ":" + handoff.requestId + "；回到原对话，按本人选定的方向继续。",
      };
      return summary(
        request.assistance ? "原对话遇到阻塞，需要你协助。" : "原对话需要你做一个选择。",
        { ask: [ask] },
        { action: "ask", turnId: found.turnId, ask },
      );
    }
    if (request?.assistance) {
      const { question, fact } = request.assistance;
      const text =
        question +
        "\n已核对：" +
        fact +
        "\n请在原对话补充或说明替代办法。" +
        (hasBudget ? "" : "本目标的自动执行轮数已用完。");
      return summary(
        "原对话已请求协助。",
        { notice: [{ key: "bound-help-" + handoff.requestId, title: "原对话需要你协助", text }] },
        { action: "attention", turnId: found.turnId },
      );
    }
    const chars = Array.from(raw);
    const text = chars.length <= 1600 ? raw : chars.slice(0, 1560).join("") + "…\n其余内容可在原对话查看。";
    if (goal.maxSteps === null) {
      const timer = continuationTimer(goalId, runId, "review");
      return summary(
        "原对话已完成一个步骤，正在核对目标下一步。",
        { later: [timer] },
        {
          action: "review-progress",
          timer,
          completedStepFingerprint: planFingerprint(stage.plan),
          turnId: found.turnId,
          // Review evidence is private; the phone notice limit must not erase completed work.
          reply:
            chars.length <= 24000
              ? raw
              : chars.slice(0, 12000).join("") +
                "\n[中间内容因上下文容量省略，不能据此认定功能缺失或要求重复执行]\n" +
                chars.slice(-12000).join(""),
          plan: stage.plan,
          ...(stage.chosen ? { chosen: stage.chosen } : {}),
        },
      );
    }
    return summary(
      "原对话已回复这次交接。",
      { notice: [{ key: "bound-result-" + handoff.requestId, title: "原对话的处理结果", text }] },
      { action: "deliver", turnId: found.turnId },
    );
  }
  if (found.status === "queued" && now - handoff.submittedAt >= 15000) {
    await wakeQueuedBoundChat({
      config,
      projectKey,
      requestId: handoff.requestId,
      text: handoff.text,
      beforeMutation: guard,
    }).catch(() => {});
  }
  const checks = inspect ? handoff.checks + 1 : 0;
  const mismatch =
    found.status === "unknown" && ["BOUND_SCOPE_MISMATCH", "BOUND_MESSAGE_CONFLICT"].includes(found.code);
  const terminal = mismatch || found.status === "missing" || now - handoff.submittedAt >= 24 * 60 * minute;
  if (terminal) {
    const text = mismatch
      ? "原聊天的归属或交接记录与本次任务不一致，请核对项目卡上的工作对话。"
      : found.status === "missing"
        ? "绑定的原对话目前不可用，请核对原对话。"
        : "仍未收到能核实的原对话结果，请查看原对话。";
    return summary(
      text,
      {
        notice: [
          {
            key: "bound-attention-" + handoff.requestId,
            title: "原对话需要核对",
            text: text + " 已保留交接记录，暂不重派。",
          },
        ],
      },
      { action: "attention" },
    );
  }
  const timer = {
    key: "bound-check-" + handoff.requestId,
    // These are cheap receipt checks, not new model attempts or business retries.
    at: new Date(now + Math.min(15 * 2 ** Math.min(checks, 2), 60) * 1000).toISOString(),
    about: `核对同一条原对话交接的回执（第 ${checks + 1} 次）`,
  };
  const note =
    found.status === "queued"
      ? "已排到原对话，等它接收。"
      : found.status === "in-thread"
        ? "原对话已接收，稍后核对最终回复。"
        : "交接状态待核实，稍后只查原记录。";
  // Only repeated loss of visibility warrants asking for help. A long queue or an active turn can be healthy.
  const uncertain =
    found.status === "unknown" && ["BOUND_UNVERIFIED", "BOUND_HANDOFF_NOT_OBSERVED"].includes(found.code);
  const uncertainCount = uncertain ? (handoff.uncertainCount ?? 0) + 1 : 0;
  const uncertainSince = uncertain ? (handoff.uncertainSince ?? now) : null;
  const askForCheck = uncertainCount >= 3 && now - uncertainSince >= 10 * minute && !handoff.checkRequested;
  const body = { later: [timer] };
  if (askForCheck)
    body.notice = [
      {
        key: "bound-verify-" + handoff.requestId,
        title: "请帮忙确认原对话是否收到了任务",
        text: "我连续几次都没能核实原对话是否接到这次工作。请在项目卡打开所选对话，看交接消息是否在里面。不用重发，我会继续核对原记录。",
      },
    ];
  return {
    ...summary(note, body, {
      action: "await-bound",
      timer,
      handoff: {
        ...handoff,
        checks,
        uncertainCount,
        uncertainSince,
        checkRequested: handoff.checkRequested || askForCheck,
      },
    }),
    state: "waiting-for-bound-chat",
  };
}
