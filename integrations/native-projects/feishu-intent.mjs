// Deterministic proposals only: no model, provider, control store, network, or execution dependency.
const SOURCES = new Set(["codex", "multica", "dsh"]);
const PROVIDER_NAMES = { codex: ["Codex"], multica: ["Multica"], dsh: ["DeepSeek", "dsh"] };
const PRONOUNS = new Set(["这个", "它", "这个项目", "该项目", "当前项目", "这个任务"]);
const SUPPORT =
  "我可以查看项目目录或状态，并准备单个项目的暂停、恢复、启用或目标提案。请使用完整项目名、来源限定名或项目卡片；提案确认前不会执行。";
const help = (text = SUPPORT) => ({ kind: "help", action: null, text });
const candidate = (row) => ({ alias: row.alias, name: row.name, provider: row.provider });
const tidy = (value) =>
  value
    .trim()
    .replace(/[。！!]+$/u, "")
    .trim();
const WORK = /^(?:继续)?(?:检查|核对|整理|处理|修复|准备|完成|生成|推进|分析|跟进|审查|验证)/u;

function projectsOf(view) {
  if (view?.kind !== "project-directory" || !Array.isArray(view.projects)) return [];
  return view.projects
    .filter(
      (row) =>
        row &&
        typeof row.alias === "string" &&
        /^[CMD]-[a-f0-9]{10}$/i.test(row.alias) &&
        SOURCES.has(row.provider) &&
        typeof row.name === "string" &&
        row.name.length > 0 &&
        !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(row.name),
    )
    .map(candidate);
}

function isQuotedData(text) {
  return (
    /[\r\n`“”‘’「」『』"'<>]/u.test(text) ||
    /(?:\*\*|\*[^*]+\*|__|(?:^|\s)_[^_]+_(?:\s|$)|\]\()/u.test(text) ||
    /^\s*(?:>|[-*+]\s|\d+[.)]\s|#{1,6}\s)/u.test(text)
  );
}

function reported(text) {
  return (
    /(?:转述|引用|原话|听说|据说|比如|例如|假如|假设|如果|解释一下|解释下|什么意思|我在考虑|我想知道|你觉得)/u.test(
      text,
    ) || /(?:说|写道|提到|转告|表示|建议|让我|叫我|要我)[：:\s]*(?:让|把|请|暂停|恢复|继续|启用|启动)/u.test(text)
  );
}

function stripPolite(text) {
  const prefix =
    /^(?:请|麻烦你?|帮我|替我|先)\s*(?=(?:请|帮我|替我|让|把|将|暂停|恢复|继续|启用|启动|设置|设定|查看|看看|看一下|查一下|查询|列出|列一下|显示))/u;
  for (let count = 0; count < 3 && prefix.test(text); count++) text = text.replace(prefix, "");
  return text.trim();
}

function resolve(target, projects, contextAlias) {
  target = tidy(target);
  if (PRONOUNS.has(target)) {
    const bound =
      typeof contextAlias === "string"
        ? projects.filter((p) => p.alias.toUpperCase() === contextAlias.toUpperCase())
        : [];
    return bound.length === 1
      ? { exact: bound[0] }
      : { candidates: bound, text: "“这个项目”还没有绑定到当前目录中的唯一项目，请先选择一张项目卡片。" };
  }
  const qualified = /^(Codex|Multica|DeepSeek|dsh)\s*[:：]\s*(.+)$/iu.exec(target);
  const provider = qualified
    ? { codex: "codex", multica: "multica", deepseek: "dsh", dsh: "dsh" }[qualified[1].toLowerCase()]
    : null;
  if (qualified) target = qualified[2].trim();
  const pool = projects.filter((p) => !provider || p.provider === provider);
  const alias = pool.filter((p) => p.alias.toUpperCase() === target.toUpperCase());
  if (alias.length === 1) return { exact: alias[0] };
  if (alias.length > 1) return { candidates: alias };
  const names = pool.filter((p) => p.name === target);
  if (names.length === 1) return { exact: names[0] };
  if (names.length > 1) return { candidates: names };
  const weak = pool.filter((p) => p.name.includes(target) || target.includes(p.name));
  return weak.length
    ? { candidates: weak, text: "这个名称不是唯一明确的完整项目名，请先确认候选项目。" }
    : { missing: true };
}

function requested(kind, action, target, projects, contextAlias, objective) {
  const found = resolve(target, projects, contextAlias);
  if (found.exact)
    return {
      kind,
      action,
      alias: found.exact.alias,
      ...(objective ? { objective } : {}),
      ...(kind === "proposal" ? { text: "这是待确认的项目提案，尚未执行。" } : {}),
    };
  if (found.candidates)
    return {
      kind: "clarify",
      action,
      candidates: found.candidates.map(candidate),
      ...(objective ? { objective } : {}),
      text: found.text ?? "这个项目名称对应多项，请选择明确的来源或项目卡片。",
    };
  return help("没有匹配到当前目录中的项目。我只处理项目查询和单项目操作提案，请先查看项目目录或使用完整名称。");
}

function directoryRequest(text) {
  const body = text.replace(/^(?:打开|看看|看一下|查看|列出|列一下|显示)\s*/u, "");
  return (
    /^(?:我(?:现在)?|现在|目前)?(?:有)?(?:哪些|什么)项目$/u.test(body) ||
    /^(?:我(?:的)?)?(?:所有|全部)?项目(?:列表|目录|清单)?$/u.test(body)
  );
}
export function asksForChatPicker(text) {
  return (
    typeof text === "string" &&
    /^(?:(?:请|帮我|让我|我要|我想)\s*)?(?:选(?:择)?|更换|切换|换)(?:一条|一个|个|一下)?(?:工作|项目|原)?(?:对话|聊天)(?:卡片)?[。！!]?$/u.test(
      text.trim(),
    )
  );
}

function statusTarget(text) {
  const headed = /^(?:看看|看一下|查看|查一下|查询)\s*(.+)$/u.exec(text);
  const body = headed ? headed[1] : text;
  const endings = [
    /^(.+?)(?:现在|目前|最近)?(?:的)?(?:状态|进度|进展)(?:怎么样|怎样|如何|是什么)?(?:了)?$/u,
    /^(.+?)(?:现在|目前|最近)(?:怎么样|怎样|如何)(?:了)?$/u,
    /^(.+?)(?:怎么样|怎样了|如何了)$/u,
    /^(.+?)(?:现在|目前)?(?:在做什么|做到哪了|做到哪一步了|有什么进展)$/u,
  ];
  for (const regex of endings) {
    const match = regex.exec(body);
    if (match) return match[1].trim();
  }
  return headed ? body.trim() : null;
}

function multipleActions(text, projects) {
  let rest = text;
  // A native project name may itself contain a control verb.
  const refs = projects.flatMap((p) => [p.name, p.alias]).sort((a, b) => b.length - a.length);
  for (const ref of refs) rest = rest.split(ref).join(" ");
  return (rest.match(/暂停|恢复|继续|启用|启动|目标(?:设为|设置为|改为)/gu) ?? []).length > 1;
}

function letGoal(body, projects) {
  const known = [
    ...PRONOUNS,
    ...projects.flatMap((p) => [
      p.alias,
      p.name,
      ...PROVIDER_NAMES[p.provider].flatMap((prefix) => [`${prefix}:${p.name}`, `${prefix}：${p.name}`]),
    ]),
  ].sort((a, b) => b.length - a.length);
  for (const target of known) {
    if (!body.startsWith(target)) continue;
    const objective = body.slice(target.length).trim();
    if (WORK.test(objective)) return { target, objective };
  }
  const weak = /^(.+?)\s*((?:继续)?(?:检查|核对|整理|处理|修复|准备|完成|生成|推进|分析|跟进|审查|验证).+)$/u.exec(
    body,
  );
  return weak ? { target: weak[1].trim(), objective: weak[2].trim() } : null;
}

export function interpretProjectRequest(text, { view, contextAlias } = {}) {
  if (typeof text !== "string" || !text.trim() || text.length > 4000 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text))
    return help();
  if (/^\s*\/?loop(?:\s|$)/iu.test(text))
    return help("这条是明确的 /loop 指令，应由原有指令入口处理，不从自然语言入口再次执行。");
  if (isQuotedData(text) || reported(text))
    return help("引用、转述或格式化内容按资料处理。请直接说一个项目查询或操作意图。");
  const projects = projectsOf(view);
  const question = /[?？]|(?:吗|么|呢)\s*[。！!]*$/u.test(text);
  const normalized = stripPolite(
    tidy(text)
      .replace(/[?？]+$/u, "")
      .trim(),
  );
  if (asksForChatPicker(normalized)) return { kind: "query", action: "pick-chat" };
  if (directoryRequest(normalized)) return { kind: "query", action: "projects" };
  const target = statusTarget(normalized);
  if (target) return requested("query", "status", target, projects, contextAlias);
  if (
    /(?:不要|不许|禁止|不用|无需|不需要|不必|暂不|先不|暂时不|不能|不想|不是要|不是让|避免)/u.test(normalized) ||
    /(?:^|[，,\s])(?:先)?别/u.test(normalized) ||
    /(?:能不能|可不可以|能否|可否|是否|会不会|要不要|该不该|怎么|如何|建议|考虑)/u.test(normalized) ||
    question
  )
    return help("这句话带有否定、询问或不确定语气，未生成操作提案。请直接说明一个项目和明确动作。");
  if (/(?:所有|全部|全体|每个|各个|都暂停|都恢复|一起)/u.test(normalized))
    return { kind: "clarify", action: null, text: "自然语言入口一次只处理一个项目，请先选择具体项目。" };
  if (multipleActions(normalized, projects))
    return { kind: "clarify", action: null, text: "这句话包含多个项目动作，请拆成单个项目、单个动作的请求。" };

  const pause =
    /^暂停\s*(.+?)(?:的自动推进)?$/u.exec(normalized) ??
    /^(?:把|将)?\s*(.+?)\s*(?:先)?暂停(?:一下)?$/u.exec(normalized);
  if (pause) return requested("proposal", "pause", pause[1], projects, contextAlias);
  const resume =
    /^(?:恢复|继续)\s*(.+?)(?:的自动推进)?$/u.exec(normalized) ??
    /^(?:把|将)?\s*(.+?)\s*恢复(?:自动推进)?$/u.exec(normalized) ??
    /^让\s*(.+?)\s*继续(?:自动)?推进$/u.exec(normalized);
  if (resume) return requested("proposal", "resume", resume[1], projects, contextAlias);
  const enable = /^(?:启用|启动)\s*(.+?)[，,：:]\s*目标(?:是|为)?[：:]?\s*(.+)$/u.exec(normalized);
  if (enable) return requested("proposal", "enable", enable[1], projects, contextAlias, enable[2].trim());
  const goal =
    /^(?:把|将)?\s*(.+?)(?:的)?目标(?:设为|设置为|改为)[：:]?\s*(.+)$/u.exec(normalized) ??
    /^(?:给|为)\s*(.+?)\s*(?:设定|设置)目标[：:]\s*(.+)$/u.exec(normalized);
  if (goal) return requested("proposal", "goal", goal[1], projects, contextAlias, goal[2].trim());
  const letMatch = /^让\s*(.+)$/u.exec(normalized);
  if (letMatch) {
    const parsed = letGoal(letMatch[1], projects);
    if (parsed) return requested("proposal", "goal", parsed.target, projects, contextAlias, parsed.objective);
  }
  const noGoal = /^(?:启用|启动)\s*(.+)$/u.exec(normalized);
  if (noGoal) {
    const matched = resolve(noGoal[1], projects, contextAlias);
    return matched.missing
      ? help()
      : {
          kind: "clarify",
          action: "enable",
          candidates: (matched.exact ? [matched.exact] : (matched.candidates ?? [])).map(candidate),
          text: "启用前需要明确本次目标，请补充希望完成什么。",
        };
  }
  return help();
}
