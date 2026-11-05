const PROVIDERS = { codex: "Codex", multica: "Multica", dsh: "DeepSeek" };
const MODES = { manual: "仅查看", active: "推进中", paused: "已暂停" };
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
      ...(typeof p.objective === "string" && p.objective ? { objective: short(p.objective, 500) } : {}),
      ...(Number.isSafeInteger(p.maxSteps) && p.maxSteps > 0 ? { maxSteps: p.maxSteps } : {}),
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
      md(`默认仅查看 · 推进中 ${active} · 已暂停 ${paused}`),
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
function navigationButtons(context, navigation) {
  const refresh =
    navigation.screen === "detail"
      ? { alias: navigation.alias }
      : navigation.screen === "list"
        ? { provider: navigation.provider, page: navigation.page }
        : {};
  return row([
    column([button(context, "返回目录", "home", {}, true)]),
    column([button(context, "刷新", "refresh", refresh)]),
  ]);
}
function interactiveHome(v, context, maxOptions) {
  const selected = v.projects.slice(0, maxOptions);
  const names = new Map();
  for (const p of selected) {
    const base = `${PROVIDERS[p.provider]} · ${plain(p.name, 60)}`;
    names.set(base, (names.get(base) ?? 0) + 1);
  }
  const picker = selected.length
    ? {
        tag: "select_static",
        name: "project",
        width: "fill",
        placeholder: text("选择一个项目查看详情"),
        options: selected.map((p) => {
          const base = `${PROVIDERS[p.provider]} · ${plain(p.name, 60)}`;
          return { text: text(base + (names.get(base) > 1 ? ` · ${p.alias}` : "")), value: p.alias };
        }),
        behaviors: callback(context, "select"),
      }
    : muted(v.complete ? "当前没有项目" : "目录待连接 请稍后刷新");
  return rootCard("个人项目", "按来源浏览 或直接选择项目", [
    summary(v, true),
    row(
      Object.keys(PROVIDERS).map((provider, i) =>
        column([
          button(context, PROVIDERS[provider], "list", { provider, page: 0 }, i === 0),
          muted(escape(providerStatus(v, provider).replace(`${PROVIDERS[provider]} · `, ""))),
        ]),
      ),
    ),
    block([
      picker,
      ...(selected.length < v.projects.length ? [muted("这里仅列出部分项目 更多项目请按来源翻页查看")] : []),
    ]),
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
function detail(v, navigation, context) {
  const p = v.projects.find((p) => p.alias === navigation.alias);
  if (!p)
    return rootCard("项目详情", "目录可能已更新", [
      block([md("**未找到这个项目**"), muted("请返回目录后重新选择")], true),
      context.interactive !== false
        ? navigationButtons(context, { screen: "home" })
        : block([md("刷新目录：/loop 项目")]),
    ]);
  return rootCard("项目详情", PROVIDERS[p.provider], [
    block([md(`**${escape(p.name, 140)}**`, "heading-3"), md(`当前 ${mode(p)}`), muted(escape(capability(p)))], true),
    block([
      md(p.objective ? `**当前目标**\n${escape(p.objective)}` : "尚未设置自动推进目标"),
      ...(p.maxSteps ? [muted(`步数上限 ${p.maxSteps}`)] : []),
    ]),
    commandHelp(p),
    ...(context.interactive !== false ? [navigationButtons(context, { screen: "detail", alias: p.alias })] : []),
  ]);
}
function staticDirectory(v, maxProjects) {
  // Fair source allocation keeps a large first provider from concealing the others.
  const groups = Object.keys(PROVIDERS).map((provider) => v.projects.filter((p) => p.provider === provider));
  const selected = new Set();
  for (let i = 0; selected.size < maxProjects && groups.some((g) => g[i]); i++)
    for (const group of groups) if (group[i] && selected.size < maxProjects) selected.add(group[i].alias);
  return rootCard("个人项目", "按来源展开 再点项目名称", [
    summary(v, false),
    ...Object.keys(PROVIDERS).map((provider) => {
      const projects = v.projects.filter((p) => p.provider === provider);
      const shown = projects.filter((p) => selected.has(p.alias));
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
        for (const alias of aliases)
          titles.set(alias, title + (aliases.length > 1 ? ` · ${alias.slice(-length)}` : ""));
      }
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
// P2/P3: 2–5 root blocks, native folding/pickers, no horizontal table or separator wall.
// P4–P7: restrained type hierarchy, container spacing, blue/grey and weighted columns.
export function renderProjectCard(view, navigation = {}, context = {}) {
  const interactive = context.interactive !== false;
  if (
    interactive &&
    (!/^[A-Za-z0-9_-]{1,120}$/.test(context.sessionId ?? "") ||
      !Number.isSafeInteger(context.revision) ||
      context.revision < 0)
  )
    throw fail("PROJECT_CARD_CONTEXT_INVALID");
  const v = normalize(view);
  const nav =
    view.kind === "project-status" && !navigation.screen
      ? { screen: "detail", alias: v.projects[0]?.alias }
      : navigation;
  let card;
  if (nav.screen === "detail") card = detail(v, nav, context);
  else if (!interactive) {
    for (let limit = Math.min(45, v.projects.length); limit >= 0; limit--) {
      card = staticDirectory(v, limit);
      if (fits(card)) break;
    }
  } else if (nav.screen === "list") card = interactiveList(v, nav, context);
  else {
    for (let limit = Math.min(60, v.projects.length); limit >= 0; limit--) {
      card = interactiveHome(v, context, limit);
      if (fits(card)) break;
    }
  }
  if (!fits(card)) throw fail("PROJECT_CARD_TOO_LARGE");
  return card;
}
