// Read one selected provider. This service never dispatches work or imports provider-specific control APIs.
import { createHash } from "node:crypto";

const fail = (code) => Object.assign(new Error(code), { code });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(value);
const instant = (value) =>
  typeof value === "string" &&
  value.length <= 80 &&
  /^\d{4}-\d\d-\d\dT/u.test(value) &&
  Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : null;
const clip = (value, length) =>
  Array.from(typeof value === "string" ? value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ") : "")
    .slice(0, length)
    .join("");
const STATES = new Set([
  "running",
  "queued",
  "busy",
  "waiting",
  "idle",
  "completed",
  "done",
  "failed",
  "cancelled",
  "stopped",
  "paused",
  "unknown",
  "error",
  "notLoaded",
  "interrupted",
  "pending",
  "in_progress",
]);
const PHASES = new Set(["commentary", "partial_answer", "final_answer", "final", "progress", "unknown"]);
const TIME_SOURCES = new Set([
  "turn-completed",
  "session-event",
  "native-message",
  "message-created",
  "message-timestamp",
  "unknown",
]);
const scopeFailure = (error) =>
  error?.code === "PROJECT_ACTIVITY_SCOPE_MISMATCH" ||
  /(?:SCOPE|MISMATCH|NOT_OWNED|HOST_CHANGED|SOCKET_CHANGED|ACCESS_DENIED|FORBIDDEN)/u.test(
    typeof error?.code === "string" ? error.code : "",
  );
const unsupportedReply = (error) =>
  /(?:PREVIEW_DISABLED|CONVERSATION_DISABLED|PREVIEW_UNSUPPORTED|METHOD_NOT_ALLOWED|METHOD_UNSUPPORTED)/u.test(
    typeof error?.code === "string" ? error.code : "",
  );

function identity(key) {
  if (typeof key !== "string" || key.length > 2048) throw fail("PROJECT_ACTIVITY_INVALID_KEY");
  let parts;
  try {
    parts = key.split(":").map(decodeURIComponent);
  } catch {
    throw fail("PROJECT_ACTIVITY_INVALID_KEY");
  }
  if (
    parts.length !== 3 ||
    parts.some((p) => !validId(p)) ||
    !/^[a-z][a-z0-9-]*$/u.test(parts[0]) ||
    parts.map(encodeURIComponent).join(":") !== key
  )
    throw fail("PROJECT_ACTIVITY_INVALID_KEY");
  return { provider: parts[0], host: parts[1], nativeId: parts[2] };
}

export function redact(value) {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/g,
      "[已隐藏密钥]",
    )
    .replace(
      /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b/g,
      "[已隐藏密钥]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[已隐藏凭据]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi, "Bearer [已隐藏凭据]")
    .replace(
      /(\b(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password)\b["']?\s*[:=]\s*["']?)[A-Za-z0-9_./+=-]{16,}/gi,
      "$1[已隐藏凭据]",
    )
    .replace(/(\b(?:Cookie|Set-Cookie)\s*:\s*[^\s;=]+=)[A-Za-z0-9%._~+/-]{16,}/gi, "$1[已隐藏凭据]");
}

function workMetadata(row) {
  const trusted =
    row.runtimeStateTrusted === true ||
    (row.runtimeStateTrusted === undefined &&
      row.statusSource !== "stored" &&
      row.state !== "unknown" &&
      row.membership !== "cwd-unassigned");
  const state = trusted && STATES.has(row.state) ? row.state : "unknown";
  return {
    nativeId: row.nativeId,
    title: clip(redact(typeof row.title === "string" ? row.title : ""), 160),
    state,
    nativeState: typeof row.nativeState === "string" ? clip(redact(row.nativeState), 80) : null,
    updatedAt: instant(row.updatedAt),
    membership: ["native-project", "cwd-unassigned", "unassigned", "unknown"].includes(row.membership)
      ? row.membership
      : "native-project",
    runtimeStateTrusted: trusted,
    ...(row.statusSource === "stored" || row.runtimeStateTrusted === false
      ? { statusSource: "stored" }
      : trusted
        ? { statusSource: "native-runtime" }
        : {}),
  };
}
const active = (work) => work.runtimeStateTrusted === true && ["running", "busy"].includes(work.state);
const order = (a, b) =>
  Number(active(b)) - Number(active(a)) ||
  Number(b.membership === "native-project") - Number(a.membership === "native-project") ||
  (b.updatedAt ? Date.parse(b.updatedAt) : -Infinity) - (a.updatedAt ? Date.parse(a.updatedAt) : -Infinity) ||
  (a.nativeId < b.nativeId ? -1 : a.nativeId > b.nativeId ? 1 : 0);

function replyView(reply) {
  if (reply == null) return null;
  if (
    !object(reply) ||
    typeof reply.text !== "string" ||
    !reply.text.trim() ||
    (reply.role !== undefined && reply.role !== "assistant") ||
    (reply.type !== undefined && !["assistant", "agentMessage", "agent_message"].includes(reply.type)) ||
    ["tool", "system"].includes(reply.phase)
  )
    return null;
  const cleaned = redact(reply.text).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
    " ",
  );
  const chars = Array.from(cleaned);
  return {
    text: chars.slice(0, 1600).join(""),
    at: instant(reply.at),
    id: typeof reply.id === "string" ? clip(redact(reply.id), 256) : null,
    phase: PHASES.has(reply.phase) ? reply.phase : null,
    truncated: reply.truncated === true || chars.length > 1600,
    ...(TIME_SOURCES.has(reply.timeSource) ? { timeSource: reply.timeSource } : {}),
  };
}

export class ProjectActivity {
  constructor(
    catalog,
    { cacheMs = 30000, timeoutMs = 8000, now = Date.now, historyLabels = [], boundChats = {} } = {},
  ) {
    if (
      !object(catalog?.connectors) ||
      !Number.isFinite(cacheMs) ||
      cacheMs < 0 ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      typeof now !== "function"
    )
      throw fail("PROJECT_ACTIVITY_INVALID_CONFIG");
    if (!Array.isArray(historyLabels)) throw fail("PROJECT_ACTIVITY_INVALID_CONFIG");
    this.boundChats = boundChats;
    this.historyLabels = new Map();
    for (const entry of historyLabels) {
      if (!object(entry) || !validId(entry.workId) || !validId(entry.title) || entry.title.length > 100)
        throw fail("PROJECT_ACTIVITY_INVALID_CONFIG");
      identity(entry.projectKey);
      const key = JSON.stringify([entry.projectKey, entry.workId]);
      if (this.historyLabels.has(key)) throw fail("PROJECT_ACTIVITY_INVALID_CONFIG");
      this.historyLabels.set(key, entry);
    }
    this.catalog = catalog;
    this.cacheMs = cacheMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.cache = new Map();
    this.inflight = new Map();
  }

  fallback(key, cacheKey, reason) {
    const cached = this.cache.get(cacheKey)?.snapshot;
    if (cached && cached.status !== "unavailable") {
      const stored = (work) => ({ ...work, state: "unknown", runtimeStateTrusted: false, statusSource: "stored" });
      return {
        ...structuredClone(cached),
        status: "stale",
        complete: false,
        works: cached.works.map(stored),
        selected: cached.selected ? stored(cached.selected) : null,
        note: "本次暂未获取更新，正在展示上次读取的旧快照；不代表任务当前状态。",
      };
    }
    return {
      status: "unavailable",
      projectKey: key,
      observedAt: null,
      complete: false,
      selection: "order-only",
      works: [],
      selected: null,
      note:
        reason === "timeout"
          ? "读取暂未完成，尚不能确认当前任务；没有启动或重派任务。"
          : "暂未获取该项目的任务与回复；这不表示项目没有任务。",
    };
  }

  async read(projectKey, { workId, force = false } = {}) {
    const target = identity(projectKey);
    const main = workId === undefined && Object.hasOwn(this.boundChats, projectKey);
    if (main) workId = this.boundChats[projectKey]?.threadId ?? "";
    if (workId !== undefined && !validId(workId)) throw fail("PROJECT_ACTIVITY_INVALID_WORK");
    if (typeof force !== "boolean") throw fail("PROJECT_ACTIVITY_INVALID_WORK");
    const cacheKey = JSON.stringify([projectKey, workId ?? null, main]);
    const backend = Object.hasOwn(this.catalog.connectors, target.provider)
      ? this.catalog.connectors[target.provider]
      : null;
    if (!backend || typeof backend.listProjects !== "function" || typeof backend.listWork !== "function")
      return {
        status: "unavailable",
        projectKey,
        observedAt: null,
        complete: false,
        selection: "order-only",
        works: [],
        selected: null,
        note: "此来源尚未接通项目动态查询，未读取任何任务。",
      };
    const cached = this.cache.get(cacheKey),
      age = cached ? this.now() - cached.storedAt : Infinity;
    if (!force && cached && age >= 0 && age < this.cacheMs) return structuredClone(cached.snapshot);
    let job = this.inflight.get(cacheKey);
    if (!job) {
      job = {};
      job.promise = this.fetch(projectKey, target, backend, workId, main);
      this.inflight.set(cacheKey, job);
      job.promise
        .then(
          (snapshot) => {
            this.cache.set(cacheKey, { snapshot: structuredClone(snapshot), storedAt: this.now() });
          },
          (error) => {
            if (scopeFailure(error))
              for (const [key, entry] of this.cache)
                if (entry.snapshot.projectKey === projectKey) this.cache.delete(key);
          },
        )
        .finally(() => {
          if (this.inflight.get(cacheKey) === job) this.inflight.delete(cacheKey);
        });
    }
    let timer;
    try {
      const snapshot = await Promise.race([
        job.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(fail("PROJECT_ACTIVITY_TIMEOUT")), this.timeoutMs);
        }),
      ]);
      return structuredClone(snapshot);
    } catch (error) {
      if (scopeFailure(error)) throw fail("PROJECT_ACTIVITY_SCOPE_MISMATCH");
      const fallback = this.fallback(
        projectKey,
        cacheKey,
        error?.code === "PROJECT_ACTIVITY_TIMEOUT" ? "timeout" : "unavailable",
      );
      this.cache.set(cacheKey, { snapshot: structuredClone(fallback), storedAt: this.now() });
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetch(projectKey, target, backend, workId, main) {
    const directory = await backend.listProjects();
    if (!Array.isArray(directory?.projects)) throw fail("PROJECT_ACTIVITY_INVALID_RESPONSE");
    const projects = directory.projects.filter(
      (p) => object(p) && p.nativeId === target.nativeId && (p.host ?? this.catalog.host ?? "local") === target.host,
    );
    if (projects.length !== 1 || (projects[0].provider !== undefined && projects[0].provider !== target.provider))
      throw fail("PROJECT_ACTIVITY_SCOPE_MISMATCH");
    const response = await backend.listWork(target.nativeId);
    if (!Array.isArray(response?.items)) throw fail("PROJECT_ACTIVITY_INVALID_RESPONSE");
    const ids = new Set();
    const rows = response.items
      .map((row) => {
        if (!object(row) || !validId(row.nativeId) || row.projectId !== target.nativeId || ids.has(row.nativeId))
          throw fail("PROJECT_ACTIVITY_SCOPE_MISMATCH");
        ids.add(row.nativeId);
        return workMetadata(row);
      })
      .sort(order);
    let complete = directory.complete === true && response.complete === true;
    if (workId !== undefined && !ids.has(workId)) throw fail("PROJECT_ACTIVITY_SCOPE_MISMATCH");
    const observedAt = instant(response.observedAt) ?? new Date(this.now()).toISOString();
    if (!rows.length) {
      if (!complete) throw fail("PROJECT_ACTIVITY_INCOMPLETE");
      return {
        status: "empty",
        projectKey,
        observedAt,
        complete: true,
        selection: "order-only",
        works: [],
        selected: null,
        note: "本次完整读取未发现该项目的会话或Issue。",
      };
    }
    let selected = rows.find((row) => row.nativeId === workId) ?? rows[0];
    const notes = [];
    let latestReply = null;
    if (typeof backend.readConversation !== "function") {
      complete = false;
      notes.push("这个来源尚未接通Agent回复读取，目前只能查看任务信息。");
    } else {
      let conversation;
      try {
        conversation = await backend.readConversation(selected.nativeId, {
          projectId: target.nativeId,
          maxChars: 1600,
        });
      } catch (error) {
        if (!unsupportedReply(error)) throw error;
        complete = false;
        notes.push("这个来源暂不支持或尚未允许读取Agent回复。");
      }
      if (conversation !== undefined) {
        if (
          !object(conversation) ||
          conversation.nativeId !== selected.nativeId ||
          conversation.projectId !== target.nativeId
        )
          throw fail("PROJECT_ACTIVITY_SCOPE_MISMATCH");
        const overlay = { ...selected, projectId: target.nativeId };
        for (const field of ["title", "state", "nativeState", "updatedAt", "runtimeStateTrusted", "statusSource"])
          if (Object.hasOwn(conversation, field)) overlay[field] = conversation[field];
        selected = workMetadata(overlay);
        rows[rows.findIndex((row) => row.nativeId === selected.nativeId)] = selected;
        latestReply = replyView(conversation.latestReply);
        if (conversation.complete !== true) complete = false;
        if (!latestReply) notes.push("这条任务暂无可展示的Agent文本回复，或回复读取范围尚未完整。");
      }
    }
    // Local display labels are private to this group. Native renames supersede a reviewed earlier title.
    const labelFor = (row) => this.historyLabels.get(JSON.stringify([projectKey, row.nativeId]));
    for (const row of rows) {
      const label = labelFor(row);
      if (label && (!row.title.trim() || row.title === row.nativeId || row.title === label.sourceTitle))
        row.title = clip(redact(label.title), 100);
    }
    const report = labelFor(selected)?.report;
    // A summary for a final answer must never follow a later message, edited excerpt or newer turn.
    const resultSummary =
      complete &&
      latestReply?.id &&
      latestReply.phase === "final_answer" &&
      report?.replyId === latestReply.id &&
      latestReply.at &&
      report.replyAt === latestReply.at &&
      selected.updatedAt &&
      report.workUpdatedAt === selected.updatedAt &&
      typeof report.summary === "string" &&
      report.summary.trim() &&
      createHash("sha256").update(latestReply.text).digest("hex") === report.replySha256
        ? clip(redact(report.summary), 240)
        : null;
    const comparison = rows.filter((row) => row.membership === selected.membership);
    const allTimesKnown = comparison.every((row) => row.updatedAt !== null);
    let selection = "order-only";
    if (main) selection = "bound-chat";
    else if (workId !== undefined) notes.push("按你选定的会话或Issue展示。");
    else if (active(selected)) selection = "trusted-active";
    else if (
      selected.updatedAt &&
      allTimesKnown &&
      response.complete === true &&
      comparison.every((row) => !row.updatedAt || Date.parse(row.updatedAt) <= Date.parse(selected.updatedAt))
    )
      selection = "latest-updated";
    if (!allTimesKnown || !selected.updatedAt) notes.push("缺少可比较的原生更新时间，不能确认哪条任务最新。");
    if (selected.membership === "cwd-unassigned") notes.push("这条旧会话按精确目录关联，未改写它的原生项目归属。");
    if (!selected.runtimeStateTrusted) notes.push("当前显示存储记录，尚未核实原生运行状态。");
    if (latestReply && !latestReply.at) notes.push("该回复未提供原生时间，不能仅凭时间确认它是最新回复。");
    if (!complete) notes.push("本次读取范围不完整，未把未读部分当作没有数据。");
    const works = rows.slice(0, 3);
    if (!works.some((row) => row.nativeId === selected.nativeId)) {
      works.pop();
      works.unshift(selected);
    }
    return {
      status: "available",
      projectKey,
      observedAt,
      complete,
      selection,
      works,
      selected: { ...selected, latestReply, ...(resultSummary ? { resultSummary } : {}) },
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  }
}
