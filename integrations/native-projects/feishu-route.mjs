import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { directGoalRequest } from "./feishu-direct-goal.mjs";
import { asksForChatPicker } from "./feishu-intent.mjs";
export function commandText(event) {
  if (typeof event?.content !== "string") return "";
  let value = event.content.trim();
  const prefixes = (Array.isArray(event.mentions) ? event.mentions : [])
    .slice(0, 50)
    .flatMap((m) =>
      m && typeof m === "object"
        ? [typeof m.key === "string" ? m.key : null, typeof m.name === "string" ? "@" + m.name : null].filter(Boolean)
        : [],
    )
    .sort((a, b) => b.length - a.length);
  for (let i = 0; i < 50; i++) {
    const p = prefixes.find((p) => value.startsWith(p) && (value.length === p.length || /\s/.test(value[p.length])));
    if (!p) break;
    value = value.slice(p.length).trimStart();
  }
  return value;
}
export function routeProjectMessage(event, routing = {}) {
  const text = commandText(event);
  if (/^\/?loop(?:\s|$)/i.test(text)) return "loop";
  if (
    routing.enabled !== true ||
    event?.sender_type !== "user" ||
    event.message_type !== "text" ||
    event.chat_id !== routing.chatId ||
    !routing.allowedSenderIds?.includes(event.sender_id) ||
    typeof event.content !== "string" ||
    event.content.length > 6000
  )
    return "legacy";
  if (!event.mentions?.some((m) => typeof m?.id === "string" && routing.botMentionIds?.includes(m.id))) return "legacy";
  if (asksForChatPicker(text) || directGoalRequest(event, routing, text)) return "loop";
  const terms = [
    "项目",
    "原对话",
    "主对话",
    "目标",
    "暂停",
    "恢复",
    "继续",
    "启用",
    "启动",
    "自动推进",
    "进度",
    "状态",
    "怎样",
    "怎么样",
    "在忙什么",
    "能做什么",
    "会做什么",
  ];
  const names = [
    ...(Array.isArray(routing.projectNames) ? routing.projectNames : []),
    ...(Array.isArray(routing.directGoalProjects) ? routing.directGoalProjects.map((p) => p?.boundChat?.title) : []),
  ];
  return terms.some((t) => text.includes(t)) ||
    names.some((n) => typeof n === "string" && n.length >= 2 && text.includes(n)) ||
    /\b[CMD]-[a-f0-9]{10}\b/i.test(text)
    ? "loop"
    : "legacy";
}
export function readRouting(file, strict = false) {
  try {
    const routing = JSON.parse(readFileSync(file, "utf8"));
    if (!routing.bindingControlsFile) return routing;
    try {
      if (!path.isAbsolute(routing.bindingControlsFile)) throw new Error("Invalid control path");
      const state = JSON.parse(readFileSync(routing.bindingControlsFile, "utf8"));
      if (
        state.version !== 1 ||
        !state.projects ||
        typeof state.projects !== "object" ||
        Array.isArray(state.projects) ||
        (state.chatBindings !== undefined &&
          (!state.chatBindings || typeof state.chatBindings !== "object" || Array.isArray(state.chatBindings)))
      )
        throw new Error("Invalid control state");
      const directGoalProjects = (routing.directGoalProjects ?? []).map((entry) => {
        if (!Object.hasOwn(state.chatBindings ?? {}, entry.projectKey)) return entry;
        const chat = state.chatBindings[entry.projectKey];
        if (
          !chat ||
          entry.projectKey !== "codex:local:" + encodeURIComponent(chat.projectId) ||
          !Number.isSafeInteger(chat.revision) ||
          chat.revision < 1 ||
          !path.isAbsolute(chat.root) ||
          !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(chat.threadId) ||
          typeof chat.title !== "string" ||
          !chat.title.trim() ||
          !Number.isFinite(Date.parse(chat.updatedAt)) ||
          !Number.isFinite(Date.parse(entry.enabledAt))
        )
          throw new Error("Invalid selected chat");
        const enabledAt = new Date(Math.max(Date.parse(chat.updatedAt), Date.parse(entry.enabledAt))).toISOString();
        return {
          ...entry,
          enabledAt,
          selectedThreadId: chat.threadId,
          boundChat: { threadId: chat.threadId, title: chat.title, enabledAt },
        };
      });
      return { ...routing, directGoalProjects };
    } catch {
      return { ...routing, directGoalProjects: [] };
    }
  } catch (error) {
    if (strict) throw error;
    return {};
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const cfg = readRouting(process.argv[2], true);
    const event = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(routeProjectMessage(event, cfg));
  } catch {
    process.exitCode = 1;
  }
}
