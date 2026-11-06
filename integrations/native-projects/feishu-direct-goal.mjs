// A named goal is a direct assignment only where the owner explicitly opted in. Other wording stays on the proposal path.
const workVerb =
  /^(?:读(?:取)?|梳理|核对|整理|准备|制定|拟定|拟|写|设计|规划|检查|分析|评估|比较|对比|列出|列|验证|起草|制作|生成|完成)/u;
const notAnAssignment = [
  /[?？\x00-\x1f\x7f\p{Cf}`<>]|(?:吗|么|呢|如何|怎么样)[。！!]?\s*$/u,
  /(?:可不可以|能不能|能否|要不要|是否应该|你觉得|假设|假如|听说|转述|比如|例如|什么意思)/u,
  /(?:先|暂时|暂|现在)?(?:不要|不用|不必|不许|不能|不想|无需|别|不)(?:真的?|再|自动|直接|马上|立即|开始)?(?:启动|推进|执行|动手|开工|开始|接手|做)/u,
  /(?:只是|只|仅|先).{0,8}(?:草稿|讨论|提案|建议)|(?:先等等|先放着|先搁置|暂缓|撤回)/u,
  /(?:暂停|恢复|启用|启动)(?:这个|该|全部|所有)项目|(?:等我|等下次)(?:确认|同意|通知|说了)(?:以后|后)?再(?:做|开始|执行|启动)/u,
];

function currentChat(entry, event) {
  const chat = entry.boundChat;
  if (
    typeof chat?.title !== "string" ||
    !chat.title.trim() ||
    chat.title.length > 160 ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(chat.threadId ?? "") ||
    !(Date.parse(chat.enabledAt) <= Number(event.create_time))
  )
    return null;
  return chat;
}

export function directGoalRequest(event, routing, text) {
  if (
    routing?.enabled !== true ||
    event?.chat_id !== routing.chatId ||
    event.sender_type !== "user" ||
    event.message_type !== "text" ||
    !Array.isArray(routing.allowedSenderIds) ||
    !routing.allowedSenderIds.includes(event.sender_id) ||
    !Array.isArray(event.mentions) ||
    event.mentions.length !== 1 ||
    !Array.isArray(routing.botMentionIds) ||
    !routing.botMentionIds.includes(event.mentions[0]?.id) ||
    !Array.isArray(routing.projectNames) ||
    !Array.isArray(routing.directGoalProjects) ||
    !/^\d{13}$/u.test(String(event.create_time ?? "")) ||
    typeof text !== "string" ||
    text.length > 1100
  )
    return null;
  const line = text.trim().replace(/^(?:请你?|麻烦你?|劳烦你?)\s*/u, "");
  const eligible = routing.directGoalProjects.filter((entry) => {
    if (
      !entry ||
      typeof entry.projectKey !== "string" ||
      !entry.projectKey.startsWith("codex:") ||
      typeof entry.name !== "string" ||
      entry.name.trim().length < 2 ||
      !(Date.parse(entry.enabledAt) <= Number(event.create_time))
    )
      return false;
    return true;
  });
  const continuation = /^(?:帮我|替我|请你|请)?(?:接着|继续|接回|接手|沿用)\s*/u.exec(line);
  let entry, tail, boundChat;
  if (continuation) {
    const addressed = line.slice(continuation[0].length);
    const matches = eligible.flatMap((p) => {
      const c = currentChat(p, event);
      if (!c) return [];
      const title = [c.title, "「" + c.title + "」", "《" + c.title + "》", "“" + c.title + "”"].find((t) =>
        addressed.startsWith(t),
      );
      if (!title) return [];
      const rest = addressed.slice(title.length);
      const boundary = /^\s*(?:(?:这|那)条)?(?:原|主)?(?:对话|聊天|会话)\s*[，,:：。]?\s*|^\s*[，,:：]\s*/u.exec(rest);
      return boundary ? [{ entry: p, tail: rest.slice(boundary[0].length) }] : [];
    });
    if (matches.length !== 1) return null;
    ({ entry, tail } = matches[0]);
    boundChat = entry.boundChat;
  } else {
    const targets = eligible.filter((p) => line.includes(p.name));
    if (targets.length !== 1) return null;
    entry = targets[0];
    const { name } = entry;
    // Only the exact approved target can precede the assignment, optionally in title quotes.
    const head = line.replace(/^(?:请你|我想让|帮我给|帮我为|帮我把|帮|给|为|让|把)\s*/u, "");
    const target = [name, "「" + name + "」", "《" + name + "》", "“" + name + "”"].find((n) => head.startsWith(n));
    if (
      !target ||
      routing.projectNames.some(
        (n) => typeof n === "string" && n.length > name.length && n.includes(name) && head.startsWith(n),
      )
    )
      return null;
    tail = head
      .slice(target.length)
      .trim()
      .replace(/^[，,:：]\s*/u, "");
  }
  const { name, projectKey } = entry;
  const declared = /^(?:的)?(?:我(?:们)?的)?(?:本次|这次)?目标(?:是|为|[：:])\s*/u.exec(tail);
  if (declared) tail = tail.slice(declared[0].length).trim();
  const objective = tail.replace(/^(?:请你|请|麻烦你?|帮我|替我)\s*/u, "").trim();
  // A project-prefixed request can also name the destination chat. Never ignore a conflicting or unclear destination.
  const destinationMentions = [
    ...objective.matchAll(
      /(?:接着|接回|接手|沿用|继续|切到|转到|交给|改用)\s*([^。！？，,；;]{1,190}?)(?:(?:这|那)条)?(?:原|主)?(?:对话|聊天|会话)/gu,
    ),
  ];
  const quotedChats = [
    ...objective.matchAll(
      /(「[^」]{1,160}」|《[^》]{1,160}》|“[^”]{1,160}”)\s*(?:(?:这|那)(?:条|个))?(?:原|主)?(?:对话|聊天|会话)/gu,
    ),
  ];
  if (destinationMentions.length || quotedChats.length) {
    const chat = currentChat(entry, event);
    const allowedTitles = chat && [
      chat.title,
      "「" + chat.title + "」",
      "《" + chat.title + "》",
      "“" + chat.title + "”",
    ];
    if (!allowedTitles || [...destinationMentions, ...quotedChats].some((m) => !allowedTitles.includes(m[1].trim())))
      return null;
    boundChat = chat;
  }
  // An explicitly stated goal can describe the intended outcome in the owner's own words.
  const vagueOrDeferred =
    /^(?:随便|随意|随缘|再说|待定|未定|不知道|不确定|先不|暂不|不要|先别|取消|暂停|恢复|启用|启动|据说|转发|转述|他说|她说|听说|如果|怎么|看看[。！!]?\s*$|试试[。！!]?\s*$|\/)/u;
  if (
    objective.length > 1000 ||
    notAnAssignment.some((r) => r.test(objective)) ||
    (declared
      ? vagueOrDeferred.test(objective)
      : !(
          workVerb.test(objective) ||
          (boundChat &&
            /^把[^。！？?]{2,350}(?:理清楚|梳理清楚|列清楚|梳理出来|整理出来|列出来|说清楚|讲清楚)(?:[。，；,.!！]|$)/u.test(
              objective,
            ))
        ))
  )
    return null;
  const detail = objective
    .replace(workVerb, "")
    .replace(/[\s，,。!！；;]/gu, "")
    .replace(/^(?:下|一下|一下子|这事|一些|那个|这个|东西|事情)$/u, "");
  if (
    detail.length < 3 ||
    routing.projectNames?.some((n) => typeof n === "string" && n.length >= 2 && n !== name && objective.includes(n))
  )
    return null;
  return {
    projectKey,
    name,
    objective,
    ...(entry.selectedThreadId && { threadId: entry.selectedThreadId }),
    ...(boundChat && { threadId: boundChat.threadId, chatTitle: boundChat.title }),
  };
}
