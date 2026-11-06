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
const readyText = (goal, stage, canAsk) =>
  [
    "大肥鱼从飞书接到这个目标：" + goal.objective,
    ...(stage.chosen
      ? [
          (stage.chosenQuestion ? "关于「" + stage.chosenQuestion + "」，" : "") +
            "你刚刚选定了「" +
            stage.chosen +
            "」。",
        ]
      : []),
    "请接着这条对话已有的进展，" + stage.plan.nextStep + "。预期交付：" + stage.plan.expectedResult + "。",
    "这次先核对现有资料，简短回复结论和下一步。已有工作不用重做；涉及改文件、启动服务、联网或对外操作，请等本人另行确认。",
    ...(canAsk
      ? [
          "只有必须由本人选方向才能继续时，才请大肥鱼把问题带回群里。这时整条回复用「需要你拍板：」开头，写一个短问题；逐行用 1.、2. 等列出两到五个可选动作，最后一句写「建议选第 1 项，因为……」（按实际推荐填写序号）。其余情况直接交付结论。",
        ]
      : []),
  ].join("\n\n");
// Parse one complete, current-turn decision. Quotations, examples in longer answers and ordinary questions remain prose.
function requestedDecision(text) {
  const lines = text
    .split(/\r?\n/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length < 4 || lines.length > 7 || /[`\p{Cc}\p{Cf}]/u.test(lines.join(""))) return null;
  const question = /^需要你拍板[：:]\s*(.{1,120})$/u.exec(lines[0])?.[1]?.trim();
  const advice = /^建议选(?:第\s*)?([1-5一二三四五])\s*(?:项)?\s*[，,]\s*因为\s*(.{1,160})$/u.exec(lines.at(-1));
  if (!question || !advice || !advice[2].trim()) return null;
  const options = [];
  for (const entry of lines.slice(1, -1)) {
    const option = /^([1-5])\s*[.．、]\s*(.{1,80})$/u.exec(entry);
    if (!option || Number(option[1]) !== options.length + 1 || !option[2].trim() || options.includes(option[2].trim()))
      return null;
    options.push(option[2].trim());
  }
  const recommend = /[1-5]/u.test(advice[1]) ? Number(advice[1]) - 1 : "一二三四五".indexOf(advice[1]);
  return recommend < options.length
    ? { title: question, options, recommend, text: "推荐理由：" + advice[2].trim() }
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
  const canAsk = remaining > 0 && !stage.chosen;
  const handoff = inspect
    ? stage.handoff
    : {
        requestId: "native-run:" + executionKey,
        text: readyText(goal, stage, canAsk),
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
    // An observation row does not use a model round. A genuine answer must still have budget to resume.
    if (handoff.canAsk === true && remaining + (inspect ? 1 : 0) > 0) {
      const decision = requestedDecision(raw);
      if (decision) {
        const ask = {
          ...decision,
          key: "bound-choice-" + handoff.requestId,
          about: "coord:" + goalId + ":" + handoff.requestId + "；回到原对话，按本人选定的方向继续。",
        };
        return summary("原对话需要你做一个选择。", { ask: [ask] }, { action: "ask", turnId: found.turnId, ask });
      }
    }
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
