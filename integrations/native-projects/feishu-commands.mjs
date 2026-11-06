import { createHash } from "node:crypto";
import { failure, projectKey } from "./catalog.mjs";

const PROVIDERS = { codex: "Codex", multica: "Multica", dsh: "DeepSeek" };
const PREFIXES = { codex: "C", multica: "M", dsh: "D" };
const MODES = { manual: "仅查看", active: "自动推进", paused: "已暂停" };
const ACTIONS = new Set(["projects", "status", "enable", "pause", "resume", "answer"]);
const USAGE =
  "/loop 项目；/loop 状态；/loop 启用 项目名或编号 | 明确目标；/loop 暂停 项目名或编号；/loop 继续 项目名或编号；/loop 回答 卡号 选项序号";
const label = (value, max = 140) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("<", "＜")
    .replaceAll(">", "＞")
    .slice(0, max);

const validTarget = (value) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 1024 && !/[|\p{Cc}\u2028\u2029]/u.test(value);

function usage() {
  return Object.assign(failure("LOOP_COMMAND_USAGE"), { userMessage: `这条项目指令格式不正确。可用：${USAGE}` });
}

// The outer relay strips verified mentions and checks sender/chat authorization first.
export function parseLoopCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const prefix = /^\/?loop(?:\s+|$)/i.exec(trimmed);
  if (!prefix) return null;
  if (trimmed.length > 6000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) throw usage();
  const body = trimmed.slice(prefix[0].length).trim();
  const answer = /^(?:回答|answer)\s+(\d+)\s+(\d+)$/i.exec(body);
  if (answer) {
    const cardId = Number(answer[1]),
      choice = Number(answer[2]);
    if (Number.isSafeInteger(cardId) && cardId > 0 && Number.isSafeInteger(choice) && choice > 0)
      return { action: "answer", cardId, choice };
    throw usage();
  }
  if (/^(?:项目|项目列表|projects)$/i.test(body)) return { action: "projects" };
  const status = /^(?:状态|status)(?:\s+([^|]+))?$/i.exec(body);
  if (status) {
    if (status[1] !== undefined && !validTarget(status[1])) throw usage();
    return { action: "status", ...(status[1] ? { target: status[1].trim() } : {}) };
  }
  const simple = /^(暂停|继续|恢复|pause|resume)\s+([^|]+)$/i.exec(body);
  if (simple) {
    if (!validTarget(simple[2])) throw usage();
    return { action: /^(暂停|pause)$/i.test(simple[1]) ? "pause" : "resume", target: simple[2].trim() };
  }
  const enable = /^(?:启用|enable)\s+([^|]+?)\s*\|\s*([^|]+?)(?:\s*\|\s*(?:步数\s+|maxSteps\s*=\s*)(\d+))?$/i.exec(
    body,
  );
  if (enable) {
    const objective = enable[2].trim();
    const maxSteps = enable[3] === undefined ? 3 : Number(enable[3]);
    if (validTarget(enable[1]) && objective && maxSteps >= 1 && maxSteps <= 100)
      return { action: "enable", target: enable[1].trim(), objective, maxSteps };
  }
  throw usage();
}

export function projectAlias(project) {
  if (!PREFIXES[project?.provider] || typeof project.host !== "string" || typeof project.nativeId !== "string")
    throw failure("INVALID_PROJECT_IDENTITY");
  const digest = createHash("sha256")
    .update(JSON.stringify([project.provider, project.host, project.nativeId]))
    .digest("hex")
    .slice(0, 10);
  return `${PREFIXES[project.provider]}-${digest}`;
}

function storedProjects(controls) {
  return (controls?.list?.() ?? []).flatMap((record) => {
    const parts = String(record.projectKey ?? "").split(":");
    if (parts.length !== 3) return [];
    try {
      const [provider, host, nativeId] = parts.map(decodeURIComponent);
      if (!PREFIXES[provider] || !host || !nativeId || projectKey(provider, host, nativeId) !== record.projectKey)
        return [];
      const project = {
        key: record.projectKey,
        provider,
        host,
        nativeId,
        capabilities: { read: false, continue: false },
        stored: true,
      };
      const nameTrusted = typeof record.projectName === "string" && record.projectName.trim().length > 0;
      return [
        { ...project, nameTrusted, name: nameTrusted ? record.projectName : `已登记项目 ${projectAlias(project)}` },
      ];
    } catch {
      return [];
    }
  });
}

function findProject(target, projects) {
  const byKey = new Map();
  for (const p of projects) if (p?.key) byKey.set(p.key, p);
  const values = [...byKey.values()];
  const exact = values.find((p) => p.key === target);
  if (exact) return exact;
  const aliases = values.filter((p) => projectAlias(p).toUpperCase() === target.toUpperCase());
  if (aliases.length > 1) throw failure("PROJECT_TARGET_AMBIGUOUS");
  if (aliases.length === 1) return aliases[0];
  const qualified = /^(Codex|Multica|DeepSeek|dsh)\s*[:：]\s*(.+)$/i.exec(target);
  const provider = qualified
    ? { codex: "codex", multica: "multica", deepseek: "dsh", dsh: "dsh" }[qualified[1].toLowerCase()]
    : null;
  const name = qualified ? qualified[2] : target;
  const matches = values.filter(
    (p) => (!p.stored || p.nameTrusted === true) && (!provider || p.provider === provider) && p.name === name,
  );
  if (matches.length > 1) throw failure("PROJECT_TARGET_AMBIGUOUS");
  return matches[0] ?? null;
}

function executionLabel(project) {
  if (project.capabilities?.queueBound === true) return "交回已绑定的原对话";
  if (project.capabilities?.startOwned === true) {
    return project.capabilities.continuationMode === "managed-read-only"
      ? "受管只读（不接管原聊天）"
      : "受管任务（不接管原聊天）";
  }
  return "";
}

// Structured views contain display data only. The renderer owns markup escaping.
const viewText = (value, max) =>
  [...(typeof value === "string" ? value : "").replace(/[\p{Cc}\u2028\u2029]/gu, " ")].slice(0, max).join("");

function projectDisplayView(project, control, { available, providerStatus } = {}) {
  const caps = project.capabilities ?? {};
  const execution =
    available === false || project.stored === true || providerStatus === "unavailable"
      ? "unavailable"
      : caps.queueBound === true
        ? "bound-chat"
        : caps.startOwned === true && caps.continuationMode === "managed-read-only"
          ? "managed-read-only"
          : caps.continue === true || caps.startOwned === true
            ? "native"
            : caps.read === true
              ? "read-only"
              : "unavailable";
  const objective = viewText(control?.objective, 500);
  return {
    alias: projectAlias(project),
    name: viewText(project.name, 140),
    provider: project.provider,
    mode: Object.hasOwn(MODES, control?.mode) ? control.mode : "manual",
    revision: Number.isSafeInteger(control?.revision) && control.revision >= 0 ? control.revision : 0,
    execution,
    ...(objective.trim() ? { objective } : {}),
    ...(Number.isSafeInteger(control?.maxSteps) && control.maxSteps >= 1 && control.maxSteps <= 100
      ? { maxSteps: control.maxSteps }
      : {}),
  };
}

export function projectDirectoryView(overview, controls) {
  const current = Array.isArray(overview?.projects) ? overview.projects : [];
  const existing = new Set(current.map((p) => p.key));
  const stored = storedProjects(controls).filter((p) => !existing.has(p.key));
  const providers = (Array.isArray(overview?.providers) ? overview.providers : [])
    .filter((entry) => Object.hasOwn(PROVIDERS, entry?.provider))
    .map((entry) => ({
      provider: entry.provider,
      status: entry.status === "connected" ? "connected" : "unavailable",
      complete: entry.status === "connected" && entry.complete === true,
    }));
  const statuses = new Map(providers.map((entry) => [entry.provider, entry.status]));
  const aliases = new Set();
  const projects = [...current, ...stored].map((project) => {
    const row = projectDisplayView(project, controls?.get?.(project.key), {
      available: existing.has(project.key),
      providerStatus: statuses.get(project.provider),
    });
    if (aliases.has(row.alias)) throw failure("PROJECT_TARGET_AMBIGUOUS");
    aliases.add(row.alias);
    return row;
  });
  return { kind: "project-directory", complete: overview?.complete === true, providers, projects };
}

export function formatProjects(overview, controls) {
  const current = Array.isArray(overview?.projects) ? overview.projects : [];
  const existing = new Set(current.map((p) => p.key));
  const stored = storedProjects(controls).filter((p) => !existing.has(p.key));
  const projects = [...current, ...stored];
  const lines = ["项目目录", "默认仅查看；只会推进你明确启用的项目"];
  for (const project of projects) {
    const control = controls?.get?.(project.key) ?? { mode: "manual" };
    const readiness = project.stored
      ? " · 目录待核对"
      : executionLabel(project)
        ? ` · ${executionLabel(project)}`
        : project.capabilities?.continue === true
          ? ""
          : " · 只读，控制待接通";
    lines.push(
      `${projectAlias(project)} · ${PROVIDERS[project.provider]} · ${label(project.name)} · ${MODES[control.mode] ?? "状态待核对"}${readiness}`,
    );
  }
  const providers = Array.isArray(overview?.providers) ? overview.providers : [];
  for (const provider of providers) {
    if (provider.status !== "connected")
      lines.push(`${PROVIDERS[provider.provider] ?? label(provider.provider)}：待连接`);
    else if (provider.complete === false)
      lines.push(`${PROVIDERS[provider.provider] ?? label(provider.provider)}：目录尚未读全`);
  }
  if (!projects.length)
    lines.push(overview?.complete === true ? "已连接来源当前没有项目" : "目录尚未完整可用，请稍后刷新");
  lines.push(
    "可直接使用精确项目名，也可用上面的短编号",
    "查看：/loop 状态 项目名",
    "启用：/loop 启用 项目名 | 明确目标",
    "例如：/loop 暂停 内容工作台；/loop 继续 内容工作台",
    "同名时使用短编号或来源限定，例如 Codex:内容工作台、Multica:内容工作台、DeepSeek:内容工作台",
    "回答问题：/loop 回答 卡号 选项序号（从1开始）",
  );
  return lines.join("\n");
}

const ERRORS = {
  CARD_ANSWER_NOT_READY: "问题回答入口尚未就绪，没有提交这条回答。",
  CARD_ANSWER_FAILED: "暂未确认这条回答已被接受，未报告提交成功。请查看问题当前状态后再处理。",
  LOOP_ACTOR_REQUIRED: "尚未确认这条指令的操作者，未更改项目。",
  COMMAND_ID_REQUIRED: "这条指令缺少可追踪的消息编号，未更改项目。",
  LOOP_COMMAND_USAGE: `这条项目指令格式不正确。可用：${USAGE}`,
  PROJECT_TARGET_NOT_FOUND: "没有找到这个精确项目名或编号。请先发送 /loop 项目，核对名称或使用清单里的短编号。",
  PROJECT_TARGET_AMBIGUOUS:
    "这个项目名或编号对应多项，未更改任何项目。请使用清单里的短编号，或用 Codex:项目名、Multica:项目名、DeepSeek:项目名限定来源。",
  PROJECT_CONTROL_NOT_READY: "该项目目前只能查看，原生控制连接尚未就绪，没有启用自动推进。",
  LOOP_READINESS_REQUIRED: "自动推进的就绪检查尚未接通，没有启用。",
  LOOP_RULES_NOT_READY: "自动推进规则尚未就绪，没有启用。",
  LOOP_READINESS_UNAVAILABLE: "暂时无法确认自动推进是否就绪，没有启用。",
  OBJECTIVE_REQUIRED: "请写清这次希望完成的目标，例如：/loop 启用 内容工作台 | 修复一个明确问题并验证。",
  INVALID_STEP_BUDGET: "步数上限必须是 1 到 100 的整数；省略时为 3。",
  LOOP_ALREADY_ACTIVE: "该项目已经按原目标自动推进。修改目标前请先明确暂停，未覆盖原目标。",
  CONTROL_REVISION_CHANGED: "项目状态已被更新，这条旧指令没有覆盖新状态。请重新查看后再操作。",
  CONTROL_UPDATE_BUSY: "另一个项目控制操作正在保存，请稍后重试。",
  INVALID_DEADLINE: "原目标的截止时间已无效，请重新明确目标后启用。",
};
function failed(action, code, extra = {}) {
  return {
    ok: false,
    action,
    code,
    changed: false,
    text: ERRORS[code] ?? "项目控制暂时未能完成，未将结果报告为成功。",
    ...extra,
  };
}
function statusText(project, control) {
  return `${projectAlias(project)} · ${label(project.name)}\n当前：${MODES[control.mode] ?? "状态待核对"}${executionLabel(project) ? `\n执行方式：${executionLabel(project)}` : ""}${control.objective ? `\n目标：${label(control.objective, 500)}` : ""}${control.maxSteps ? `\n步数上限：${control.maxSteps}` : ""}\n暂停自动推进不会自行取消已经开始的当前任务。`;
}

export async function handleLoopCommand(
  command,
  { catalog, controls, actor, requestId, readiness, syncRules, resolveStored, answerCard } = {},
) {
  const action = command?.action;
  if (typeof actor !== "string" || !actor.trim()) return failed(action, "LOOP_ACTOR_REQUIRED");
  if (!ACTIONS.has(action)) return failed(action, "LOOP_COMMAND_USAGE");
  const mutation = ["enable", "pause", "resume", "answer"].includes(action);
  if (mutation && (typeof requestId !== "string" || !requestId.trim() || requestId.length > 512))
    return failed(action, "COMMAND_ID_REQUIRED");
  if (action === "answer") {
    if (
      !Number.isSafeInteger(command.cardId) ||
      command.cardId < 1 ||
      !Number.isSafeInteger(command.choice) ||
      command.choice < 1
    )
      return failed(action, "LOOP_COMMAND_USAGE");
    if (typeof answerCard !== "function") return failed(action, "CARD_ANSWER_NOT_READY");
    try {
      const response = await answerCard({ cardId: command.cardId, choice: command.choice, actor, requestId });
      if (
        response?.accepted === false ||
        response?.ok === false ||
        (response?.accepted !== true && response?.ok !== true)
      )
        return failed(action, "CARD_ANSWER_FAILED");
      const duplicate =
        response?.duplicate === true || response?.alreadyAnswered === true || response?.alreadyHandled === true;
      return {
        ok: true,
        action,
        changed: !duplicate,
        cardId: command.cardId,
        choice: command.choice,
        text: duplicate
          ? "该问题的这条回答已处理，没有重复提交。"
          : `已提交问题 ${command.cardId} 的第 ${command.choice} 个选项，等待原任务处理。`,
      };
    } catch {
      return failed(action, "CARD_ANSWER_FAILED");
    }
  }
  if (action !== "projects" && !(action === "status" && !command.target) && !validTarget(command.target))
    return failed(action, "LOOP_COMMAND_USAGE");
  if (typeof command.target === "string") command = { ...command, target: command.target.trim() };
  let overview, project;
  try {
    // Capture control versions before any native lookup can yield to a newer owner decision.
    const revisions = new Map((controls?.list?.() ?? []).map((record) => [record.projectKey, record.revision ?? 0]));
    // A pause must not wait on a slow or disconnected native provider.
    if (action === "pause") project = findProject(command.target, storedProjects(controls));
    if (!project) {
      try {
        overview = await catalog.refresh();
      } catch (error) {
        if (!["pause", "status"].includes(action)) throw error;
        overview = { complete: false, projects: [], providers: [] };
      }
      if (action === "projects" || (action === "status" && !command.target))
        return {
          ok: true,
          action,
          changed: false,
          complete: overview.complete === true,
          text: formatProjects(overview, controls),
          view: projectDirectoryView(overview, controls),
        };
      project = findProject(command.target, [...storedProjects(controls), ...(overview.projects ?? [])]);
      if (!project && ["pause", "status"].includes(action)) {
        const supplied = resolveStored ? await resolveStored(command.target) : [];
        project = findProject(command.target, [
          ...storedProjects(controls),
          ...(Array.isArray(supplied) ? supplied : supplied ? [supplied] : []),
        ]);
      }
    }
    if (!project) return failed(action, "PROJECT_TARGET_NOT_FOUND");
    const before = controls.get(project.key);
    if (
      command.expectedRevision !== undefined &&
      (!Number.isSafeInteger(command.expectedRevision) ||
        command.expectedRevision < 0 ||
        command.expectedRevision !== before.revision)
    )
      return failed(action, "CONTROL_REVISION_CHANGED");
    if (before.revision !== (revisions.get(project.key) ?? 0)) return failed(action, "CONTROL_REVISION_CHANGED");
    if (action === "status")
      return {
        ok: true,
        action,
        changed: false,
        projectKey: project.key,
        mode: before.mode,
        revision: before.revision,
        text: statusText(project, before),
        view: {
          kind: "project-status",
          project: projectDisplayView(project, before, {
            available: (overview?.projects ?? []).some((entry) => entry.key === project.key),
            providerStatus: overview?.providers?.find((entry) => entry.provider === project.provider)?.status,
          }),
        },
      };
    if (action === "enable") {
      if (typeof command.objective !== "string" || !command.objective.trim() || command.objective.length > 5000)
        return failed(action, "OBJECTIVE_REQUIRED");
      const steps = command.maxSteps ?? 3;
      if (!Number.isSafeInteger(steps) || steps < 1 || steps > 100) return failed(action, "INVALID_STEP_BUDGET");
      if (before.mode === "active" && (before.objective !== command.objective.trim() || before.maxSteps !== steps))
        return failed(action, "LOOP_ALREADY_ACTIVE");
    }
    if (action !== "pause") {
      if (
        project.capabilities?.continue !== true &&
        project.capabilities?.startOwned !== true &&
        project.capabilities?.queueBound !== true
      )
        return failed(action, "PROJECT_CONTROL_NOT_READY");
      if (action === "resume" && (!before.objective || !Number.isSafeInteger(before.maxSteps)))
        return failed(action, "OBJECTIVE_REQUIRED");
      if (typeof readiness !== "function") return failed(action, "LOOP_READINESS_REQUIRED");
      const ready = await readiness(project, { command, control: before });
      if (!ready || ready.ready !== true) return failed(action, "LOOP_READINESS_UNAVAILABLE");
      if (ready.rulesReady !== true) return failed(action, "LOOP_RULES_NOT_READY");
    }
    const next = controls.set(project.key, action === "pause" ? "paused" : "active", {
      actor,
      requestId,
      expectedRevision: before.revision,
      ...(!project.stored || project.nameTrusted === true ? { projectName: project.name } : {}),
      ...(action === "enable"
        ? {
            objective: command.objective.trim(),
            maxSteps: command.maxSteps ?? 3,
            ...(command.expectedThreadId && { expectedThreadId: command.expectedThreadId }),
          }
        : {}),
    });
    const current = controls.get(project.key);
    if (current.revision !== next.revision || current.mode !== next.mode) {
      return {
        ok: true,
        action,
        changed: false,
        projectKey: project.key,
        mode: current.mode,
        revision: current.revision,
        superseded: true,
        text: `该指令已处理；${projectAlias(project)} 当前为${MODES[current.mode] ?? "待核对"}，没有覆盖较新的项目状态。`,
      };
    }
    if (syncRules) {
      try {
        const synced = await syncRules({ projectKey: project.key, control: current, action, requestId });
        if (synced?.ok === false) throw failure("RULE_SYNC_UNCONFIRMED");
      } catch {
        if (action !== "pause") {
          try {
            controls.set(project.key, "paused", {
              actor,
              expectedRevision: current.revision,
              requestId: `${requestId}:sync-failed`,
            });
          } catch {
            /* A newer owner decision must not be overwritten. */
          }
        }
        const actual = controls.get(project.key);
        return failed(action, "RULE_SYNC_UNCONFIRMED", {
          changed: true,
          projectKey: project.key,
          mode: actual.mode,
          revision: actual.revision,
          syncStatus: "unconfirmed",
          cancelRunning: false,
          text: `${projectAlias(project)} 当前为${MODES[actual.mode] ?? "待核对"}。规则同步尚未确认，未报告自动推进已启动；已经开始的当前任务未被取消。`,
        });
      }
    }
    const after = controls.get(project.key);
    if (after.revision !== current.revision || after.mode !== current.mode)
      return {
        ok: true,
        action,
        changed: true,
        projectKey: project.key,
        mode: after.mode,
        revision: after.revision,
        text: `指令已处理；${projectAlias(project)} 当前为${MODES[after.mode] ?? "待核对"}，以最新决定为准。`,
      };
    return {
      ok: true,
      action,
      changed: next.revision !== before.revision,
      projectKey: project.key,
      mode: next.mode,
      revision: next.revision,
      cancelRunning: false,
      syncStatus: syncRules ? "confirmed" : "not-requested",
      text:
        action === "pause"
          ? `${projectAlias(project)} 已暂停自动推进，不再安排下一步。已经开始的当前任务不会因此被取消。`
          : `${projectAlias(project)} 已${action === "resume" ? "恢复" : "启用"}自动推进。${executionLabel(project) ? `\n执行方式：${executionLabel(project)}` : ""}\n目标：${label(next.objective, 500)}\n步数上限：${next.maxSteps}。其他项目保持原状态。`,
    };
  } catch (error) {
    return failed(action, typeof error?.code === "string" ? error.code : "LOOP_COMMAND_FAILED");
  }
}
