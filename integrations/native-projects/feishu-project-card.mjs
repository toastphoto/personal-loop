const PROVIDERS = { codex: "Codex", multica: "Multica", dsh: "DeepSeek" };
const MODES = { manual: "仅查看", active: "已启用", paused: "已暂停" };
const EXECUTION = {
  "managed-read-only": "可执行独立只读任务 不接管原聊天",
  native: "已连接原生控制 仍需明确目标后启用",
  "read-only": "可查看项目 自动推进尚未接通",
  unavailable: "目录待核对 暂不启用新的任务",
};
const PAGE_SIZE = 4;
const MAX_BYTES = 28000;
const MAX_ELEMENTS = 180;
const fail = (code) => Object.assign(new Error(code), { code });
const short = (value, limit) => {
  const chars = Array.from(String(value ?? "").replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " "));
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : chars.join("");
};
const plain = (value, limit = 140) =>
  short(value, limit)
    .replaceAll("<", "＜")
    .replaceAll(">", "＞")
    .replace(/https?:\/\//gi, (v) => v.replace(":", "："));
// Escape once, including existing entities and punctuation that can create links or mentions.
const escape = (value, limit = 500) =>
  short(value, limit).replace(/[&<>*~\[\]()#:_`!\\|./=+-]/g, (c) => `&#${c.charCodeAt(0)};`);
const text = (content) => ({ tag: "plain_text", content });
const goalValid = (goal) =>
  typeof goal?.objective === "string" &&
  goal.objective.trim().length > 0 &&
  goal.objective.length <= 1000 &&
  Number.isSafeInteger(goal.maxSteps) &&
  goal.maxSteps >= 1 &&
  goal.maxSteps <= 100;
// Confirmation must preserve the full goal, including line breaks, without creating markup.
const goalMarkdown = (value) => String(value).replace(/[&<>*~\[\]()#:_`!\\|./=+-]/g, (c) => `&#${c.charCodeAt(0)};`);
const goalPlain = (value) =>
  String(value)
    .replaceAll("<", "＜")
    .replaceAll(">", "＞")
    .replace(/https?:\/\//gi, (v) => v.replace(":", "："));
const md = (content, text_size = "normal") => ({ tag: "markdown", content, text_size });
const muted = (content) => md(`<font color='grey'>${content}</font>`, "notation");
const column = (elements, extra = {}) => ({
  tag: "column",
  width: "weighted",
  weight: 1,
  vertical_spacing: "8px",
  elements,
  ...extra,
});
const row = (columns) => ({ tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns });
const block = (elements, highlighted = false) =>
  row([column(elements, highlighted ? { background_style: "blue-50", padding: "12px" } : {})]);
const panel = (title, elements) => ({
  tag: "collapsible_panel",
  expanded: false,
  header: { title: text(title), background_color: "grey-50" },
  vertical_spacing: "8px",
  padding: "8px",
  elements,
});
const mode = (p) => MODES[p.mode] ?? "状态待核对";
const capability = (p) => EXECUTION[p.execution] ?? EXECUTION["read-only"];

const ACTIVITY_STATES = {
  running: "执行中",
  inProgress: "执行中",
  queued: "排队中",
  pending: "排队中",
  claimed: "已接单",
  preparing: "准备中",
  waiting: "等待处理",
  idle: "当前空闲",
  completed: "本轮已结束",
  failed: "本轮失败",
  cancelled: "本轮已取消",
  interrupted: "本轮已中断",
  cancelling: "正在取消",
  unknown: "待核对",
};
const validNativeId = (value) =>
  typeof value === "string" && value.trim() && value.length <= 256 && !/[\p{Cc}]/u.test(value);
const activityTime = (value) =>
  typeof value === "string" && value.length <= 60 && Number.isFinite(Date.parse(value)) ? value : null;
function activityWork(value) {
  if (!value || typeof value !== "object" || !validNativeId(value.nativeId)) return null;
  return {
    nativeId: value.nativeId,
    title: typeof value.title === "string" && value.title !== value.nativeId ? short(value.title, 140) : "",
    state: Object.hasOwn(ACTIVITY_STATES, value.state) ? value.state : "unknown",
    nativeState: typeof value.nativeState === "string" ? short(value.nativeState, 60) : "unknown",
    updatedAt: activityTime(value.updatedAt),
    membership: ["native-project", "cwd-unassigned"].includes(value.membership) ? value.membership : "unknown",
  };
}
function activityView(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const works = [],
    seen = new Set();
  for (const raw of Array.isArray(value.works) ? value.works : []) {
    const work = activityWork(raw);
    if (!work || seen.has(work.nativeId)) continue;
    seen.add(work.nativeId);
    works.push(work);
    if (works.length === 3) break;
  }
  let selected = activityWork(value.selected);
  if (selected) {
    let latestReply = null;
    const reply = value.selected.latestReply;
    if (reply && typeof reply.text === "string" && reply.text.trim()) {
      let text = "",
        count = 0,
        clipped = false;
      for (const char of reply.text.replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
        " ",
      )) {
        if (count++ >= 1600) {
          clipped = true;
          break;
        }
        text += char;
      }
      latestReply = {
        text,
        at: activityTime(reply.at),
        phase: ["final", "final_answer", "progress", "commentary", "partial_answer"].includes(reply.phase)
          ? reply.phase
          : null,
        truncated: reply.truncated === true || clipped,
        timeSource: ["turn-completed", "session-event", "message-created", "unknown"].includes(reply.timeSource)
          ? reply.timeSource
          : "unknown",
      };
    }
    const resultSummary =
      typeof value.selected.resultSummary === "string" ? value.selected.resultSummary.slice(0, 1600) : "";
    selected = { ...selected, latestReply, resultSummary };
  }
  return {
    status: ["available", "empty", "unavailable", "stale", "loading"].includes(value.status)
      ? value.status
      : "unavailable",
    observedAt: activityTime(value.observedAt),
    complete: value.complete === true,
    selection: ["latest-updated", "trusted-active", "order-only", "explicit", "selected", "only-work"].includes(
      value.selection,
    )
      ? value.selection
      : null,
    works,
    selected,
    ...(typeof value.note === "string" ? { note: short(value.note, 300) } : {}),
  };
}
function activityDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
function normalize(view) {
  if (!["project-directory", "project-status"].includes(view?.kind)) throw fail("PROJECT_CARD_VIEW_INVALID");
  const source = view.kind === "project-status" ? [view.project] : view.projects;
  if (!Array.isArray(source)) throw fail("PROJECT_CARD_VIEW_INVALID");
  const seen = new Set();
  const projects = source.map((p) => {
    if (!p || !Object.hasOwn(PROVIDERS, p.provider) || !/^[CMD]-[a-f0-9]{10}$/.test(p.alias ?? ""))
      throw fail("PROJECT_CARD_VIEW_INVALID");
    if (seen.has(p.alias)) throw fail("PROJECT_CARD_DUPLICATE_ALIAS");
    seen.add(p.alias);
    return {
      alias: p.alias,
      name: short(p.name || "未命名项目", 140),
      provider: p.provider,
      mode: p.mode,
      execution: p.execution,
      ...(p.activity ? { activity: activityView(p.activity) } : {}),
      ...(typeof p.objective === "string" && p.objective ? { objective: p.objective } : {}),
      ...(Number.isSafeInteger(p.maxSteps) && p.maxSteps > 0 ? { maxSteps: p.maxSteps } : {}),
      controlRevision: p.controlRevision ?? p.revision,
      canSetGoal: p.canSetGoal === true,
      canStart: p.canStart === true,
      canPause: p.canPause === true,
      canResume: p.canResume === true,
      ...(typeof p.controlReason === "string" ? { controlReason: short(p.controlReason, 300) } : {}),
      ...(p.draft && typeof p.draft === "object"
        ? {
            draft: {
              objective: typeof p.draft.objective === "string" ? p.draft.objective : "",
              maxSteps: p.draft.maxSteps,
              revision: p.draft.revision,
            },
          }
        : {}),
    };
  });
  return { projects, providers: Array.isArray(view.providers) ? view.providers : [], complete: view.complete === true };
}
function providerStatus(v, provider) {
  const status = v.providers.find((p) => p.provider === provider);
  const count = v.projects.filter((p) => p.provider === provider).length;
  if (status?.status !== "connected") return `${PROVIDERS[provider]} · 待连接${count ? ` · ${count} 项待核对` : ""}`;
  if (status.complete !== true) return `${PROVIDERS[provider]} · 未读全 · 已列出 ${count} 项`;
  return `${PROVIDERS[provider]} · ${count} 个项目`;
}
function warnings(v) {
  return Object.keys(PROVIDERS)
    .filter((provider) => {
      const p = v.providers.find((item) => item.provider === provider);
      return p?.status !== "connected" || p.complete !== true;
    })
    .map((provider) => providerStatus(v, provider));
}
function summary(v, interactive) {
  const active = v.projects.filter((p) => p.mode === "active").length;
  const paused = v.projects.filter((p) => p.mode === "paused").length;
  return block(
    [
      md(`**${v.complete ? "" : "已列出 "}${v.projects.length} 个项目**`, "heading-3"),
      md(`默认仅查看 · 已启用 ${active} · 已暂停 ${paused}`),
      muted(interactive ? "选择项目查看不会启用自动推进" : "点来源和项目名称展开 查看不会启用自动推进"),
      ...warnings(v).map((warning) => muted(escape(warning))),
      ...(!v.complete && !warnings(v).length ? [muted("目录尚未完整可用 请稍后刷新")] : []),
    ],
    true,
  );
}
function commandHelp(project) {
  const lines = project
    ? [
        `查看状态\n\`/loop 状态 ${project.alias}\``,
        ...(project.mode === "active" ? [`暂停后续推进\n\`/loop 暂停 ${project.alias}\``] : []),
        ...(project.mode === "paused" ? [`恢复原目标\n\`/loop 继续 ${project.alias}\``] : []),
        ...(["managed-read-only", "native"].includes(project.execution) && project.mode !== "active"
          ? [`启用新目标\n\`/loop 启用 ${project.alias} | 明确目标\``]
          : []),
        "暂停后续推进不会取消已开始的当前任务",
      ]
    : [
        "展开项目后可复制它的查看指令",
        "设置目标：/loop 启用 精确项目名 | 明确目标",
        "暂停：/loop 暂停 精确项目名",
        "恢复：/loop 继续 精确项目名",
        "同名项目使用展开后的短编号替换项目名",
        "刷新目录：/loop 项目",
      ];
  return panel(project ? "操作说明与短编号" : "使用说明", [md(lines.join("\n\n"), "notation")]);
}
function rootCard(title, subtitle, elements) {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      enable_forward: false,
      summary: { content: "个人项目目录 · 默认仅查看" },
    },
    header: { title: text(plain(title, 80)), subtitle: text(plain(subtitle, 90)), template: "blue" },
    body: { direction: "vertical", padding: "12px", vertical_spacing: "12px", elements },
  };
}
function callback(context, action, extra = {}) {
  return [
    {
      type: "callback",
      value: { personal_loop: "projects-v1", session: context.sessionId, revision: context.revision, action, ...extra },
    },
  ];
}
function button(context, title, action, extra = {}, primary = false) {
  return {
    tag: "button",
    text: text(plain(title, 96)),
    type: primary ? "primary_filled" : "default",
    width: "fill",
    behaviors: callback(context, action, extra),
  };
}
function navigationButtons(context, navigation, primary = true) {
  const refresh =
    navigation.screen === "detail"
      ? { alias: navigation.alias }
      : navigation.screen === "list"
        ? { provider: navigation.provider, page: navigation.page }
        : {};
  return row([
    column([
      button(
        context,
        "返回目录",
        "home",
        Object.hasOwn(PROVIDERS, navigation.provider) ? { provider: navigation.provider } : {},
        primary,
      ),
    ]),
    column([button(context, "刷新", "refresh", refresh)]),
  ]);
}
function projectTitles(projects) {
  const names = new Map();
  for (const p of projects) {
    const title = plain(p.name, 70);
    if (!names.has(title)) names.set(title, []);
    names.get(title).push(p.alias);
  }
  const titles = new Map();
  for (const [title, aliases] of names) {
    // Compare the full source, not the visible slice, so budget trimming cannot rename entries.
    let length = 6;
    while (length < 10 && new Set(aliases.map((alias) => alias.slice(-length))).size < aliases.length) length++;
    for (const alias of aliases) titles.set(alias, title + (aliases.length > 1 ? ` · ${alias.slice(-length)}` : ""));
  }
  return titles;
}
function selectedAliases(v, limit) {
  const groups = Object.keys(PROVIDERS).map((provider) => v.projects.filter((p) => p.provider === provider));
  const selected = new Set();
  for (let i = 0; selected.size < limit && groups.some((g) => g[i]); i++)
    for (const group of groups) if (group[i] && selected.size < limit) selected.add(group[i].alias);
  return selected;
}
function interactiveHome(v, navigation, context, maxProjects) {
  const selected = selectedAliases(v, maxProjects);
  return rootCard("个人项目", "展开来源查看完整清单", [
    summary(v, true),
    ...Object.keys(PROVIDERS).map((provider) => {
      const projects = v.projects.filter((p) => p.provider === provider);
      const shown = projects.filter((p) => selected.has(p.alias));
      const titles = projectTitles(projects);
      const source = panel(providerStatus(v, provider), [
        ...shown.map((p) =>
          button(context, titles.get(p.alias) + (p.mode !== "manual" ? ` · ${mode(p)}` : ""), "detail", {
            alias: p.alias,
          }),
        ),
        ...(shown.length < projects.length
          ? [muted(`此处展示 ${shown.length} / ${projects.length} 项 其余请用 /loop 状态 精确项目名 查询`)]
          : []),
        ...(!projects.length ? [muted(providerStatus(v, provider))] : []),
      ]);
      source.expanded = navigation.provider === provider;
      return source;
    }),
    commandHelp(),
  ]);
}
function interactiveList(v, navigation, context) {
  const provider = Object.hasOwn(PROVIDERS, navigation.provider) ? navigation.provider : "codex";
  const projects = v.projects.filter((p) => p.provider === provider);
  const pages = Math.max(1, Math.ceil(projects.length / PAGE_SIZE));
  const page = Number.isSafeInteger(navigation.page) ? Math.min(pages - 1, Math.max(0, navigation.page)) : 0;
  const entries = projects.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const paging = [];
  if (page > 0) paging.push(column([button(context, "上一页", "page", { provider, page: page - 1 })]));
  if (page + 1 < pages) paging.push(column([button(context, "下一页", "page", { provider, page: page + 1 })]));
  return rootCard(PROVIDERS[provider], `第 ${page + 1} / ${pages} 页 · 每页最多 ${PAGE_SIZE} 项`, [
    block([md(`**${escape(providerStatus(v, provider))}**`), muted("点项目查看详情 不会启用自动推进")], true),
    block(
      entries.length
        ? entries.flatMap((p) => [
            button(context, plain(p.name, 70) + (p.mode !== "manual" ? ` · ${mode(p)}` : ""), "detail", {
              alias: p.alias,
            }),
          ])
        : [
            muted(
              v.providers.some((p) => p.provider === provider && p.status === "connected" && p.complete === true)
                ? "此来源当前没有项目"
                : "此来源目录暂不可用",
            ),
          ],
    ),
    ...(paging.length ? [row(paging)] : []),
    navigationButtons(context, { screen: "list", provider, page }),
  ]);
}
function projectControls(p, context) {
  if (context.interactive === false || context.mutationEnabled !== true) return null;
  const buttons = [];
  if (p.canPause) {
    const pause = button(context, "暂停后续推进", "pause", { alias: p.alias }, true);
    pause.confirm = { title: text("暂停这个项目"), text: text("暂停后续自动推进 不会取消已经开始的当前任务") };
    buttons.push(pause);
  }
  if (p.canResume) buttons.push(button(context, "恢复原目标", "resume", { alias: p.alias }, !buttons.length));
  if (p.canStart && goalValid(p.draft))
    buttons.push(button(context, "检查并启动", "start", { alias: p.alias }, !buttons.length));
  if (p.canSetGoal)
    buttons.push(
      button(
        context,
        p.mode === "active" ? "设置下一目标" : "设置目标",
        "edit-goal",
        { alias: p.alias },
        !buttons.length,
      ),
    );
  return buttons.length ? row(buttons.map((b) => column([b]))) : null;
}
// Use only the selected reply (or its verified delivered summary). Keep the source available in a fold.
function replyDigest(source, delivered = false) {
  const lines = source.replace(/```[\s\S]*?(?:```|$)/g, "\n").split(/\r?\n/);
  const clean = (v) =>
    v
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*]\s+|\d+[.)、]\s*)/u, "")
      .replace(/\*\*|__/g, "")
      .trim();
  const technical = (v) =>
    /(?:https?:\/\/|(?:^|[\s(`])(?:\.\.?\/|\/|~\/)|\b[a-z][\w.-]+\/[\w.-]+|\b[\w.-]+\.(?:md|json|ndjson|ya?ml|py|m?js|ts|sql|sh)\b|[a-f\d]{24,}|[{}]|`)/iu.test(
      v,
    );
  const handoff = !delivered && /^项目简报[：:]\s*(.+)$/u.exec(lines.find((line) => line.trim())?.trim() ?? "")?.[1];
  if (handoff && !technical(handoff) && !/[|｜]/u.test(handoff)) return short(handoff, 118);
  const prose = lines.flatMap((line) => {
    if (/[|｜]/u.test(line) || /^(?:下表|证据简称|证据来源|文件与行号|以下是|以下为)/u.test(clean(line))) return [];
    return (clean(line).match(/[^。！？!?]+[。！？!?]?/gu) ?? [])
      .map((s) => s.trim())
      .filter((v) => v.length > 3 && !technical(v) && !/[:：]$/.test(v));
  });
  if (delivered && prose.length > 0 && prose.length <= 2 && prose.join("").length <= 118) return prose.join("");
  // For an evidence table, use the status cells only when the writer explicitly labeled that column.
  let statusCol = -1;
  const statuses = [];
  for (const line of lines) {
    if (!line.trim().startsWith("|")) {
      statusCol = -1;
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map(clean);
    const header = cells.findIndex((c) => /^(已确定|当前情况|当前状态|进展|结论|现状)$/.test(c));
    if (header >= 0) {
      statusCol = header;
      continue;
    }
    if (statusCol >= 0 && cells[statusCol] && /[\p{L}]/u.test(cells[statusCol]) && !technical(cells[statusCol])) {
      statuses.push(cells[statusCol]);
    }
  }
  const status = /^(?:当前|目前|现阶段|现在|还在|仍在|仍需)/u;
  const decision =
    /(?:待(?:你|您|定|选|选择|决定|确认)|需要(?:你|您|决定)|请(?:你|您)?选择|尚待|尚需|接下来|下一步|建议先)/u;
  const first = prose.find((v) => status.test(v)) ?? statuses[0] ?? prose[0];
  if (!first) return "";
  const next =
    !decision.test(first) &&
    [...prose, ...statuses.flatMap((v) => v.split(/[；;]/u))].find(
      (v) => decision.test(v) && !first.includes(v) && !technical(v),
    );
  const finish = (v) => (/[。！？.!?…]$/.test(v) ? v : v + "。");
  const digest = (finish(first) + (next ? finish(next) : ""))
    .replaceAll("视觉气质", "设计风格")
    .replaceAll("放量门槛", "扩大使用的条件");
  return short(digest, 118);
}

function workName(work, noun, selected, index) {
  const title = work.title.trim();
  if (
    title &&
    !/^(?:未命名(?:会话|任务|记录)?|untitled(?: (?:chat|thread|session))?)(?:\s*[·-].*)?$/i.test(title) &&
    !/^[a-f\d]{8}(?:[a-f\d-]{12,})$/i.test(title)
  )
    return short(title, 42);
  const subject =
    work.nativeId === selected?.nativeId &&
    selected.latestReply?.text.split("\n", 1)[0].match(/《([^《》\n]{2,50})》/u)?.[1];
  if (subject) return short(subject, 42);
  return work.updatedAt
    ? activityDate(work.updatedAt).slice(0, -3) + " 的" + noun
    : `日期未记录的${noun}（第 ${index + 1} 条）`;
}

function activitySection(p, context) {
  const a = p.activity;
  if (!a) return null;
  const noun = p.provider === "multica" ? "事项" : "会话";
  const selected = a.selected;
  const reply = selected?.latestReply;
  const elements = [],
    info = [];
  if (a.status === "loading") elements.push(md("正在读取项目记录"));
  else if (a.status === "unavailable") elements.push(md("暂时无法读取项目记录"));
  else if (a.status === "empty") elements.push(md("这次尚未找到可查看的项目记录"));
  else {
    if (a.status === "stale") elements.push(muted("上次的缓存记录"));
    if (selected) {
      const name = workName(selected, noun, selected, 0);
      const label = ["final", "final_answer"].includes(reply?.phase)
        ? "最近最终回复"
        : ["progress", "commentary", "partial_answer"].includes(reply?.phase)
          ? "最近进展"
          : "回复";
      const delivered = reply && replyDigest(selected.resultSummary, true);
      const concise = reply && (delivered || replyDigest(reply.text));
      const caption = delivered
        ? "上次结论"
        : ["progress", "commentary", "partial_answer"].includes(reply?.phase)
          ? "进展摘要"
          : "回复摘要";
      const running =
        a.status !== "stale" && ["running", "inProgress", "queued", "pending", "failed"].includes(selected.state);
      elements.push(md(`**${caption}**${running ? " · " + ACTIVITY_STATES[selected.state] : ""}`));
      elements.push(
        md(concise ? escape(concise, 118) : reply ? "回复里是明细，可展开查看。" : "这条记录尚未读到回复。"),
      );
      info.push(md(`**${escape(name, 42)}**`), muted(`记录中的执行状态：${ACTIVITY_STATES[selected.state]}`));
      if (a.selection === "latest-updated") info.push(muted("按更新时间选择的记录"));
      if (a.selection === "trusted-active") info.push(muted("优先显示已核实正在执行的记录"));
      if (selected.membership === "cwd-unassigned") info.push(muted("目录关联会话 原生项目归属尚未设置"));
      if (reply) {
        info.push(
          md(`**${label}**`),
          md("> " + goalMarkdown(reply.text).replace(/\r\n?/g, "\n").split("\n").join("\n> ")),
        );
        if (reply.truncated) info.push(muted("回复较长 此处已截断"));
        info.push(
          muted(
            reply.at
              ? `${reply.timeSource === "turn-completed" ? "本轮结束时间" : "回复记录时间"} ${activityDate(reply.at)}`
              : "回复时间待核对",
          ),
        );
      }
    } else elements.push(md("尚未选定记录"));
  }
  if (a.observedAt) info.push(muted(`读取时间 ${activityDate(a.observedAt)}`));
  if (!a.complete) info.push(muted("本次读取范围尚未完整"));
  if (a.note) info.push(muted(escape(a.note, 300)));
  if (info.length) elements.push(panel(reply ? "查看回复原文与来源" : "查看记录来源", info));
  if (context.interactive !== false) {
    const names = a.works.map((w, i) => workName(w, noun, selected, i));
    const history = a.works.map((w, i) => {
      const name = names.indexOf(names[i]) !== names.lastIndexOf(names[i]) ? `${names[i]}（记录 ${i + 1}）` : names[i];
      return button(context, name, "activity-work", { alias: p.alias, workId: w.nativeId });
    });
    const tools = [
      muted(`点${noun}名称查看当时的回复`),
      ...history,
      button(context, "重新读取回复", "activity-refresh", { alias: p.alias }),
    ];
    elements.push(panel(history.length ? `查看${noun}记录（${history.length}）` : "更新记录", tools));
  }
  return block(elements);
}
function detail(v, navigation, context) {
  const p = v.projects.find((p) => p.alias === navigation.alias);
  if (!p)
    return rootCard("项目详情", "目录可能已更新", [
      block([md("**未找到这个项目**"), muted("请返回目录后重新选择")], true),
      context.interactive !== false
        ? navigationButtons(context, { screen: "home" })
        : block([md("刷新目录：/loop 项目")]),
    ]);
  const controls = projectControls(p, context);
  const goalLine = (value) =>
    escape(
      value
        .trim()
        .split(/[。；;\r\n]/u)
        .find((line) => line.trim())
        ?.trim() ?? value,
      64,
    );
  const brief = [md(`**当前 ${mode(p)}**`)];
  if (p.mode !== "manual" && p.objective) {
    brief.push(md(`${p.mode === "paused" ? "已暂停的目标" : "当前目标"} · ${goalLine(p.objective)}`));
  }
  if (p.draft?.objective) brief.push(md(`目标草稿 · ${goalLine(p.draft.objective)}`));
  if (p.mode === "manual" && !p.draft?.objective) {
    brief.push(
      muted(
        ["managed-read-only", "native"].includes(p.execution) ? "设置目标后，由你确认启动" : "目前可以查看项目进展",
      ),
    );
  }

  const details = [
    ...(p.objective ? [md(`**${p.mode === "manual" ? "上次目标" : "已设目标"}**\n${goalMarkdown(p.objective)}`)] : []),
    ...(p.maxSteps ? [muted(`自动运行上限 ${p.maxSteps} 轮`)] : []),
    ...(p.draft?.objective ? [md(`**未启动的草稿**\n${goalMarkdown(p.draft.objective)}`)] : []),
    ...(p.draft?.maxSteps ? [muted(`草稿上限 ${p.draft.maxSteps} 轮`)] : []),
    muted(escape(capability(p))),
    ...(p.controlReason ? [muted(escape(p.controlReason))] : []),
    ...commandHelp(p).elements,
  ];
  const card = rootCard(p.name, PROVIDERS[p.provider], [
    block(brief, true),
    ...(controls ? [controls] : []),
    ...(p.activity ? [activitySection(p, context)] : []),
    panel("目标详情与操作说明", details),
    ...(context.interactive !== false
      ? [navigationButtons(context, { screen: "detail", alias: p.alias, provider: p.provider }, !controls)]
      : []),
  ]);
  card.config.summary.content = plain(`${p.name} · ${mode(p)}`, 100);
  return card;
}
function backToProject(context, alias) {
  return row([column([button(context, "返回项目", "detail", { alias })])]);
}
function goalForm(v, navigation, context) {
  const p = v.projects.find((p) => p.alias === navigation.alias);
  if (!p || context.interactive === false || context.mutationEnabled !== true || !p.canSetGoal)
    return detail(v, navigation, context);
  const validDraft = goalValid(p.draft);
  const choices = [1, 3, 5, 10];
  if (validDraft && !choices.includes(p.draft.maxSteps)) choices.push(p.draft.maxSteps);
  return rootCard("设置项目目标", plain(p.name, 80), [
    block(
      [
        md("**保存草稿不会启动**", "heading-3"),
        muted("当前项目模式和正在执行的目标保持不变"),
        ...(p.draft?.objective && !validDraft ? [muted("旧草稿内容或轮数超出表单范围 未截断预填 请重新填写")] : []),
      ],
      true,
    ),
    {
      tag: "form",
      name: "goal_form",
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "input",
          name: "objective",
          label: text("希望完成什么"),
          label_position: "top",
          placeholder: text("写清目标和怎样算完成"),
          input_type: "multiline_text",
          rows: 4,
          max_length: 1000,
          required: true,
          width: "fill",
          ...(validDraft ? { default_value: p.draft.objective } : {}),
        },
        {
          tag: "select_static",
          name: "max_steps",
          placeholder: text("最多自动运行几轮"),
          required: true,
          width: "fill",
          initial_option: String(validDraft ? p.draft.maxSteps : 3),
          options: choices.map((n) => ({
            text: text(`${n} 轮${[1, 3, 5, 10].includes(n) ? "" : "（当前）"}`),
            value: String(n),
          })),
        },
        {
          tag: "button",
          name: `plgoal_${context.sessionId}_${context.revision}`,
          form_action_type: "submit",
          text: text("保存目标草稿"),
          type: "primary_filled",
          width: "fill",
        },
      ],
    },
    backToProject(context, p.alias),
  ]);
}
function confirmGoal(v, navigation, context, resume) {
  const p = v.projects.find((p) => p.alias === navigation.alias);
  const goal = resume ? p : p?.draft;
  const permitted =
    p && context.interactive !== false && context.mutationEnabled === true && (resume ? p.canResume : p.canStart);
  if (!permitted || !goalValid(goal)) {
    return rootCard(resume ? "恢复原目标" : "启动前确认", p ? plain(p.name, 80) : "项目待核对", [
      block(
        [
          md("**暂时不能确认启动**"),
          muted(!permitted ? "项目控制未就绪 请返回项目刷新状态" : "请先保存完整目标和有效轮数 目标最多1000字"),
        ],
        true,
      ),
      context.interactive !== false && p ? backToProject(context, p.alias) : block([md("刷新目录：/loop 项目")]),
    ]);
  }
  const confirm = button(
    context,
    resume ? "确认恢复" : "确认启动",
    resume ? "confirm-resume" : "confirm-start",
    { alias: p.alias },
    true,
  );
  confirm.confirm = {
    title: text(resume ? "确认恢复原目标" : "确认启动这个目标"),
    text: text(
      `${goalPlain(goal.objective)}\n\n最多 ${goal.maxSteps} 轮${resume ? " · 不会重置已使用轮数" : ""}\n${capability(p)}`,
    ),
  };
  return rootCard(resume ? "恢复前确认" : "启动前确认", plain(p.name, 80), [
    block([md(resume ? "**继续原目标**" : "**启动这个目标**", "heading-3"), muted(escape(capability(p)))], true),
    block([
      md(goalMarkdown(goal.objective)),
      md(`最多 ${goal.maxSteps} 轮`),
      ...(resume ? [muted("恢复不会重置已使用轮数 不采用另存的新草稿")] : [muted("确认后才开始自动推进")]),
    ]),
    row([column([confirm]), column([button(context, "返回项目", "detail", { alias: p.alias })])]),
  ]);
}
function probeCard(context) {
  return rootCard("连接验证", "验证卡片按钮能否正常响应", [
    block([md("**验证按钮连接**", "heading-3"), muted("本次验证不会启动项目 或改变项目模式")], true),
    context.interactive !== false
      ? block([button(context, "验证按钮连接", "probe", {}, true)])
      : block([muted("按钮连接尚未开启 请使用 /loop 项目 查看目录")]),
  ]);
}
function withNotice(card, notice) {
  if (typeof notice === "string" && notice.trim())
    card.body.elements[0]?.columns?.[0]?.elements.push(muted(escape(notice, 300)));
  return card;
}
function staticDirectory(v, maxProjects) {
  // Fair source allocation keeps a large first provider from concealing the others.
  const selected = selectedAliases(v, maxProjects);
  return rootCard("个人项目", "按来源展开 再点项目名称", [
    summary(v, false),
    ...Object.keys(PROVIDERS).map((provider) => {
      const projects = v.projects.filter((p) => p.provider === provider);
      const shown = projects.filter((p) => selected.has(p.alias));
      const titles = projectTitles(projects);
      return panel(providerStatus(v, provider), [
        ...shown.map((p) =>
          panel(titles.get(p.alias) + (p.mode !== "manual" ? ` · ${mode(p)}` : ""), [
            md(
              `${plain(p.name, 70) !== plain(p.name, 140) ? `**${escape(p.name, 140)}**\n\n` : ""}当前 ${mode(p)}\n${escape(capability(p))}\n\n查看状态\n\`/loop 状态 ${p.alias}\``,
              "notation",
            ),
          ]),
        ),
        ...(shown.length < projects.length
          ? [muted(`此处展示 ${shown.length} / ${projects.length} 项 其余请用 /loop 状态 精确项目名 查询`)]
          : []),
        ...(!projects.length ? [muted(providerStatus(v, provider))] : []),
      ]);
    }),
    commandHelp(),
  ]);
}
function countElements(value) {
  if (!value || typeof value !== "object") return 0;
  return (typeof value.tag === "string" ? 1 : 0) + Object.values(value).reduce((n, v) => n + countElements(v), 0);
}
function fits(card) {
  return Buffer.byteLength(JSON.stringify(card)) <= MAX_BYTES && countElements(card) <= MAX_ELEMENTS;
}

// P0: every project is reachable or omissions are explicit. P1: one highlighted summary.
// P2/P3: 2–5 root blocks, native source folding, no horizontal table or separator wall.
// P4–P7: restrained type hierarchy, container spacing, blue/grey and weighted columns.
export function renderProjectCard(view, navigation = {}, context = {}) {
  const interactive = context.interactive !== false;
  if (
    interactive &&
    (!/^[A-Za-z0-9_-]{1,120}$/.test(context.sessionId ?? "") ||
      !Number.isSafeInteger(context.revision) ||
      context.revision < 0 ||
      (context.mutationEnabled === true && !/^[a-f0-9]{24}$/.test(context.sessionId ?? "")))
  )
    throw fail("PROJECT_CARD_CONTEXT_INVALID");
  const v = normalize(view);
  const nav =
    view.kind === "project-status" && !navigation.screen
      ? { screen: "detail", alias: v.projects[0]?.alias }
      : navigation;
  const decorated = (card) => withNotice(card, context.notice);
  let card;
  if (nav.screen === "probe") card = decorated(probeCard(context));
  else if (nav.screen === "goal") card = decorated(goalForm(v, nav, context));
  else if (nav.screen === "confirm-start") card = decorated(confirmGoal(v, nav, context, false));
  else if (nav.screen === "confirm-resume") card = decorated(confirmGoal(v, nav, context, true));
  else if (nav.screen === "detail") card = decorated(detail(v, nav, context));
  else if (!interactive) {
    for (let limit = Math.min(45, v.projects.length); limit >= 0; limit--) {
      card = decorated(staticDirectory(v, limit));
      if (fits(card)) break;
    }
  } else if (nav.screen === "list") card = decorated(interactiveList(v, nav, context));
  else {
    for (let limit = Math.min(80, v.projects.length); limit >= 0; limit--) {
      card = decorated(interactiveHome(v, nav, context, limit));
      if (fits(card)) break;
    }
  }
  if (!fits(card)) throw fail("PROJECT_CARD_TOO_LARGE");
  return card;
}
