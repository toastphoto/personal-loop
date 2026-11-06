// Read-only evidence for a portfolio question. Never choose a worker or read conversation bodies here.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { subjectFor } from "./controls.mjs";
import { redact } from "./project-activity.mjs";
import { RUN_LEASE } from "../../kernel/due.ts";

const providers = { codex: "Codex", multica: "Multica", dsh: "DeepSeek" };
const supported = new Set([
  "running",
  "queued",
  "enabled",
  "paused",
  "decisions",
  "waiting",
  "review",
  "recent",
  "overview",
]);
const list = (names) =>
  names.length <= 6 ? names.join("、") : names.slice(0, 6).join("、") + " 等 " + names.length + " 个项目";
const field = (value) =>
  typeof value === "string"
    ? value
        .replace(/[\p{Cc}\p{Cf}<>]/gu, " ")
        .trim()
        .slice(0, 80)
    : "";
const asDate = (value) => (Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN);
const timeLabel = (value) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);

function mappedProjects(overview, controls, provider, projectKey) {
  const projects = new Map();
  const insert = (key, name, source, mode, startId) => {
    if (
      !Object.hasOwn(providers, source) ||
      typeof key !== "string" ||
      !key.startsWith(source + ":") ||
      (provider && source !== provider) ||
      (projectKey && key !== projectKey)
    )
      return;
    const current = projects.get(key);
    projects.set(key, {
      ...current,
      key,
      source,
      name: current?.name || field(name) || providers[source] + "项目",
      mode: mode ?? current?.mode ?? "manual",
      startId,
    });
  };
  for (const p of overview.projects ?? []) insert(p.key, p.name, p.provider);
  for (const c of controls.list())
    insert(c.projectKey, c.projectName, c.projectKey?.split(":")[0], c.mode, c.goalStartEvent);
  const counts = new Map();
  for (const p of projects.values()) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  for (const p of projects.values()) p.label = counts.get(p.name) > 1 ? providers[p.source] + " · " + p.name : p.name;
  return projects;
}

function hubStatus(nativeConfig, projects, now, focus) {
  const rules = new Map([...projects.values()].map((p) => ["native-project:" + subjectFor(p.key), p.label]));
  const groups = {
    running: new Set(),
    queued: new Set(),
    unknown: new Set(),
    decisions: new Set(),
    review: new Map(),
    recent: new Map(),
  };
  const cfg = nativeConfig?.loopHub?.configFile;
  if (!cfg || !path.isAbsolute(cfg)) throw Error("No verified loop configuration");
  const db = new DatabaseSync(path.join(path.dirname(cfg), "hub.db"), { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    // Filter on indexed projection state and rule; result rows contain no prompt, answer text, user ID or delivery ref.
    const known = JSON.stringify([...rules.keys()]);
    const select = (collection, fields, condition) =>
      db
        .prepare(
          "SELECT json_extract(data,'$.rule') AS rule, " +
            fields +
            " FROM projections WHERE collection='" +
            collection +
            "' AND " +
            condition +
            " AND json_extract(data,'$.rule') IN (SELECT value FROM json_each(?))",
        )
        .all(known);
    for (const row of select(
      "runs",
      "json_extract(data,'$.state') AS state,json_extract(data,'$.seen_at') AS seen",
      "json_extract(data,'$.state') IN ('claimed','queued','unknown')",
    )) {
      const age = now - asDate(row.seen),
        group =
          row.state === "queued"
            ? "queued"
            : row.state === "claimed" && age >= 0 && age <= RUN_LEASE
              ? "running"
              : "unknown";
      groups[group].add(rules.get(row.rule));
    }
    if (["waiting", "decisions", "review", "overview"].includes(focus)) {
      const current = new Map(
        [...projects.values()]
          .filter((p) => p.mode === "active")
          .map((p) => ["native-project:" + subjectFor(p.key), p]),
      );
      const ids = [...current.values()].map((p) => p.startId).filter(Boolean);
      const starts = new Map(
        db
          .prepare(
            "SELECT json_extract(data,'$.key') AS id, json_extract(data,'$.subject') AS subject, json_extract(data,'$.received_at') AS at FROM projections WHERE collection='events' AND json_extract(data,'$.key') IN (SELECT value FROM json_each(?))",
          )
          .all(JSON.stringify(ids))
          .map((e) => [e.subject + ":" + e.id, asDate(e.at)]),
      );
      const currentGoal = (row) => {
        const p = current.get(row.rule);
        return p && (!p.startId || asDate(row.created) >= starts.get(subjectFor(p.key) + ":" + p.startId));
      };
      for (const row of select(
        "cards",
        "json_extract(data,'$.created_at') AS created",
        "json_extract(data,'$.state')='open' AND json_extract(data,'$.kind')='ask'",
      ))
        if (currentGoal(row)) groups.decisions.add(rules.get(row.rule));
      for (const row of select(
        "timers",
        "json_extract(data,'$.at') AS due,json_extract(data,'$.created_at') AS created",
        "json_extract(data,'$.event_id') IS NULL",
      )) {
        const name = rules.get(row.rule),
          due = asDate(row.due);
        if (currentGoal(row) && Number.isFinite(due) && (!groups.review.has(name) || due < groups.review.get(name)))
          groups.review.set(name, due);
      }
    }
    // Ask for the latest completion per known rule rather than materializing historical run records.
    if (focus === "recent")
      for (const row of db
        .prepare(
          "SELECT json_extract(data,'$.rule') AS rule,MAX(json_extract(data,'$.finished_at')) AS at,json_extract(data,'$.summary') AS brief FROM projections WHERE collection='runs' AND json_extract(data,'$.state')='done' AND json_extract(data,'$.rule') IN (SELECT value FROM json_each(?)) GROUP BY rule",
        )
        .all(known)) {
        const at = asDate(row.at);
        if (Number.isFinite(at)) {
          const sentence = redact(typeof row.brief === "string" ? row.brief : "")
            .replace(/^项目简报[：:]\s*/u, "")
            .split(/[\r\n]/u)[0]
            .trim();
          const brief = /[|｜`{}<>]|https?:\/\/|(?:^|[ \t(])(?:~\/|\/|\.\/)|[a-f\d]{24,}/iu.test(sentence)
            ? ""
            : field(sentence);
          groups.recent.set(rules.get(row.rule), { at, brief });
        }
      }
    return groups;
  } finally {
    db.close();
  }
}

// Different providers use different meanings of “active”. An Issue's board status alone is never a runtime signal.
const runStates = new Set(["running", "busy", "cancelling"]);
const queueStates = new Set(["queued", "pending", "claimed", "preparing"]);
const doneStates = new Set([
  "idle",
  "done",
  "success",
  "succeeded",
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "interrupted",
  "stopped",
]);
async function nativeStatus(source, projects, ctx, deadline) {
  const { catalog, overview, nativeConfig } = ctx,
    backend = catalog?.connectors?.[source];
  const running = new Set(),
    queued = new Set();
  let partial = false;
  const status = overview.providers?.find((p) => p.provider === source);
  if (status?.status !== "connected" || !backend) return { source, running, queued, gap: "暂未连接" };
  if (source === "codex" && (backend.mode ?? nativeConfig.providers?.codex?.mode) === "isolated-readonly-api")
    return { source, running, queued, gap: "桌面会话的运行状态未核实" };
  partial = status.complete !== true;
  const sourceProjects = overview.projects.filter((p) => p.provider === source && projects.has(p.key));
  // Bound the *total* calls per source. Stop scheduling new reads once a reader times out.
  const boundedProjects = sourceProjects.slice(0, 12);
  if (sourceProjects.length > boundedProjects.length) partial = true;
  let issueBudget = 12,
    index = 0;
  const checkState = (state, name) => {
    if (runStates.has(state)) running.add(name);
    else if (queueStates.has(state)) queued.add(name);
    else if (!doneStates.has(state)) partial = true;
  };
  async function reader() {
    while (index < boundedProjects.length && Date.now() < deadline) {
      const p = boundedProjects[index++],
        name = projects.get(p.key).label;
      try {
        const info = await backend.listWork(p.nativeId);
        if (info?.complete !== true) partial = true;
        if (!Array.isArray(info?.items)) throw Error();
        if (info.items.some((row) => !row || row.projectId !== p.nativeId || !row.nativeId)) throw Error();
        const items =
          source === "multica"
            ? [...info.items].sort(
                (a, b) =>
                  Number(b.issueState === "in_progress") - Number(a.issueState === "in_progress") ||
                  (asDate(b.updatedAt) || 0) - (asDate(a.updatedAt) || 0),
              )
            : info.items;
        for (const row of items) {
          if (Date.now() >= deadline) {
            partial = true;
            break;
          }
          if (source === "multica") {
            if (issueBudget <= 0) {
              partial = true;
              break;
            }
            issueBudget--;
            const evidence = await backend.readWork(row.nativeId, { projectId: p.nativeId });
            if (
              evidence?.projectId !== p.nativeId ||
              evidence.nativeId !== row.nativeId ||
              !Array.isArray(evidence.runs)
            ) {
              partial = true;
              continue;
            }
            for (const run of evidence.runs) checkState(run.state, name);
          } else if (
            (source === "codex" && row.runtimeStateTrusted === true) ||
            (source === "dsh" && row.agentAvailable === true)
          ) {
            checkState(row.state, name);
          } else partial = true;
        }
      } catch {
        partial = true;
      }
    }
  }
  let timer;
  const finished = await Promise.race([
    Promise.all([reader(), reader()]).then(() => true),
    new Promise((r) => {
      timer = setTimeout(() => r(false), Math.max(0, deadline - Date.now()));
    }),
  ]);
  clearTimeout(timer);
  return {
    source,
    running: new Set(running),
    queued: new Set(queued),
    gap: partial || !finished || index < boundedProjects.length ? "只核实了部分原生状态" : null,
  };
}

export async function projectPortfolioStatus({
  nativeConfig,
  controls,
  catalog,
  overview,
  focus = "running",
  projectKey,
  provider,
  now = Date.now(),
  timeoutMs = 2400,
}) {
  if (!supported.has(focus) || (provider && !Object.hasOwn(providers, provider)))
    throw Error("Unsupported portfolio query");
  const projects = mappedProjects(overview, controls, provider, projectKey);
  if (projectKey && !projects.size)
    return { ok: true, action: "portfolio-status", text: "还未核实这个项目的状态，请在项目卡里选一下。" };
  const enabled = [...projects.values()].filter((p) => p.mode === "active").map((p) => p.label);
  const paused = [...projects.values()].filter((p) => p.mode === "paused").map((p) => p.label);
  const scope = projectKey ? [...projects.values()][0].label + " · " : provider ? providers[provider] + " · " : "";
  const lines = [];
  let hub;
  try {
    if (!["enabled", "paused"].includes(focus)) hub = hubStatus(nativeConfig, projects, now, focus);
  } catch {
    /* An unavailable state store cannot establish zero work. */
  }
  const show = (what, names) => {
    if (names.size) lines.push(what + "：" + list([...names]));
  };
  if (focus === "enabled" || focus === "paused") {
    const active = focus === "enabled",
      names = active ? enabled : paused;
    lines.push(
      names.length
        ? (active ? "已启用自动推进：" : "已暂停自动推进：") + list(names)
        : active
          ? "当前没有启用自动推进的项目。"
          : "当前没有已暂停的项目。",
    );
  } else if (!hub) lines.push("大肥鱼暂时无法核实调度状态。");
  else if (focus === "recent") {
    const recent = [...hub.recent].sort((a, b) => b[1].at - a[1].at).slice(0, 3);
    lines.push(
      recent.length
        ? "大肥鱼最近处理过：" +
            recent
              .map(([name, { at, brief }]) => name + "（" + timeLabel(at) + "）" + (brief ? " " + brief : ""))
              .join("\n")
        : "大肥鱼还没有已完成的执行记录。",
    );
  } else if (focus === "decisions" || focus === "waiting") {
    if (hub.decisions.size) show("待你拍板", hub.decisions);
    else lines.push("大肥鱼当前没有待你拍板的问题。");
  } else if (focus === "review") {
    const reviews = [...hub.review].sort((a, b) => a[1] - b[1]);
    lines.push(
      reviews.length
        ? "已预约复查：" + list(reviews.map(([name, at]) => name + "（" + timeLabel(at) + "）"))
        : "大肥鱼当前没有预约复查。",
    );
  } else {
    if (focus !== "queued") show("大肥鱼正在处理", hub.running);
    show("大肥鱼排队中", hub.queued);
    show("执行状态待核实", hub.unknown);
    if (!lines.length)
      lines.push(focus === "queued" ? "大肥鱼当前没有排队的项目。" : "大肥鱼当前没有正在处理或排队的项目。");
    if (focus === "overview") {
      show("待你拍板", hub.decisions);
      show("已预约复查", new Set(hub.review.keys()));
    }
    if (enabled.length) lines.push("已启用自动推进：" + list(enabled));
  }
  if (["running", "queued", "overview"].includes(focus)) {
    const sources = Object.keys(nativeConfig?.providers ?? {}).filter(
      (s) =>
        Object.hasOwn(providers, s) &&
        nativeConfig.providers[s]?.enabled !== false &&
        (!provider || s === provider) &&
        (!projectKey || projects.get(projectKey)?.source === s),
    );
    const deadline = Date.now() + Math.max(1, Math.min(4000, Number.isFinite(timeoutMs) ? timeoutMs : 2400));
    const native = await Promise.all(
      sources.map((s) => nativeStatus(s, projects, { nativeConfig, catalog, overview }, deadline)),
    );
    const gaps = [];
    for (const s of native) {
      if (focus !== "queued") show(providers[s.source] + " 正在执行", s.running);
      show(providers[s.source] + " 排队中", s.queued);
      if (s.gap) gaps.push(providers[s.source] + " " + s.gap);
    }
    if (gaps.length) lines.push(gaps.join("；") + "。");
    else if (native.length && !native.some((s) => (focus !== "queued" && s.running.size) || s.queued.size))
      lines.push("已核实的原生项目中也没有" + (focus === "queued" ? "排队任务。" : "正在执行或排队的任务。"));
  }
  return { ok: true, action: "portfolio-status", text: scope + lines.join("\n") };
}
