// An explicit binding keeps the router off the sidebar. Only the user's designated thread receives work.
import { readFileSync } from "node:fs";
import { queueBoundChat, inspectBoundChat } from "./bound-chat.mjs";
import { readBoundProgress, runEphemeralCoordinator } from "./ephemeral-coordinator.mjs";
import { captureProgress, coordinatedPrompt, coordinatedResult } from "./coordinated-work.mjs";
import { failure } from "./catalog.mjs";
import { redact } from "./project-activity.mjs";
const minute = 60000;
const jsonReceipt = (summary, body) =>
  summary + "\n```agent-autoloop\n" + JSON.stringify(body).replaceAll("`", "\\u0060") + "\n```";
const readyText = (goal, stage) =>
  [
    "大肥鱼从飞书接到这个目标：" + goal.objective,
    ...(stage.chosen ? ["你刚刚选定了「" + stage.chosen + "」。"] : []),
    "请接着这条对话已有的进展，" + stage.plan.nextStep + "。预期交付：" + stage.plan.expectedResult + "。",
    "这次先核对现有资料，简短回复结论和下一步。已有工作不用重做；涉及改文件、启动服务、联网或对外操作，请等本人另行确认。",
  ].join("\n\n");
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
  if (stage.role === "router") {
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
      parsed = coordinatedResult(done.text, { stage, goalId, runId, remaining, subject });
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
      state: "completed",
      evidence,
      originalText: done.text,
      usageStatus: done.turnUsageStatus,
      ...(done.turnUsage && { usage: done.turnUsage }),
    };
  }
  const inspect = stage.role === "bound-observe";
  const now = Date.now();
  const handoff = inspect
    ? stage.handoff
    : {
        requestId: "native-run:" + executionKey,
        text: readyText(goal, stage),
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
    beforeMutation: guard,
  });
  const meta = {
    role: inspect ? "bound-observe" : "worker",
    runId,
    threadId: binding.threadId,
    transportStatus: found.status,
  };
  const summary = (text, body, extra) => ({
    state: "completed",
    text: jsonReceipt(text, body),
    coordinator: { ...meta, ...extra },
    usageStatus: "not-reported",
  });
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
    const chars = Array.from(raw);
    const text = chars.length <= 1600 ? raw : chars.slice(0, 1560).join("") + "…\n其余内容可在原对话查看。";
    return summary(
      "原对话已回复这次交接。",
      { notice: [{ key: "bound-result-" + handoff.requestId, title: "原对话的处理结果", text }] },
      { action: "deliver", turnId: found.turnId },
    );
  }
  const checks = inspect ? handoff.checks + 1 : 0;
  const terminal = found.status === "missing" || checks >= 48 || now - handoff.submittedAt >= 24 * 60 * minute;
  if (terminal) {
    const text =
      found.status === "missing"
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
    at: new Date(now + Math.min(2 ** (checks + 1), 30) * minute).toISOString(),
    about: `核对同一条原对话交接的回执（第 ${checks + 1} 次）`,
  };
  const note =
    found.status === "queued"
      ? "已排到原对话，等它接收。"
      : found.status === "in-thread"
        ? "原对话已接收，稍后核对最终回复。"
        : "交接状态待核实，稍后只查原记录。";
  return {
    ...summary(note, { later: [timer] }, { action: "await-bound", timer, handoff: { ...handoff, checks } }),
    state: "waiting-for-bound-chat",
  };
}
