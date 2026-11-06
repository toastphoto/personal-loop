// Replies and decision clicks arrive through the existing group relay.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { Card, ChannelContext } from "../../host/channels.ts";

const problem = (code: string) => Object.assign(new Error(code), { code });
const messageId = (value: unknown): value is string => typeof value === "string" && /^om_[A-Za-z0-9_-]+$/.test(value);

function clean(card: Card, value: string | null) {
  let text = value ?? "";
  if (card.link) text = text.split(card.link).join("[授权链接已隐藏]");
  return text.replaceAll("<", "＜").replaceAll(">", "＞");
}

function heading(card: Card) {
  return card.state === "open"
    ? card.kind === "ask"
      ? "待你决定"
      : "进展通知"
    : card.state === "decided"
      ? "决定已记录，等待处理"
      : card.state === "done"
        ? "处理结果"
        : "事项已结案";
}

function outcome(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  return [
    chosen ? `你的选择：${clean(card, chosen)}` : "",
    card.state === "decided" ? "决定已收到，尚未确认执行完成" : card.result ? `结果：${clean(card, card.result)}` : "",
  ].filter(Boolean);
}

// New coordinator asks put the reason on the last line. Earlier cards keep their prose as delivered.
function messageLines(card: Card): string[] {
  const body = clean(card, card.text);
  if (!body) return [];
  if (card.kind !== "ask" || card.recommend === null) return [body];
  const option = card.options[card.recommend];
  const match = /(?:^|\r?\n)推荐理由[：:][ \t]*([^\r\n]+)$/u.exec(body.trimEnd());
  const reason = match?.[1].trim();
  if (!option || !match || !reason) return [body];
  const context = body.slice(0, match.index).trimEnd();
  return [
    ...(context ? [context] : []),
    ...(card.state === "open" ? [`建议选「${clean(card, option)}」：${reason}`] : []),
  ];
}

export function renderText(card: Card): string {
  if (!Number.isSafeInteger(card.id) || card.id < 1) throw problem("INVALID_CARD_ID");
  const lines = [`${heading(card)} #${card.id}`, clean(card, card.title), ...messageLines(card)];
  if (card.state === "open" && card.kind === "ask") {
    if (!card.options.length) throw problem("CARD_OPTIONS_REQUIRED");
    lines.push(
      ...card.options.map(
        (option, index) => `${index + 1}. ${clean(card, option)}${index === card.recommend ? "（建议）" : ""}`,
      ),
    );
    lines.push(`请选择上面的编号，例如：/loop 回答 ${card.id} 1`);
  } else if (card.state === "open") lines.push("无需回复");
  else lines.push(...outcome(card));
  return lines.filter(Boolean).join("\n");
}

export function renderDecisionCard(card: Card) {
  if (
    card.kind !== "ask" ||
    !Number.isSafeInteger(card.id) ||
    card.id < 1 ||
    !Number.isSafeInteger(card.version) ||
    card.version < 1
  )
    throw problem("INVALID_DECISION_CARD");
  const plain = (content: string) => ({ tag: "plain_text", content });
  const block = (content: string) => ({ tag: "div", text: plain(content) });
  const elements: Record<string, unknown>[] = [block(clean(card, card.title))];
  elements.push(...messageLines(card).map(block));
  if (card.state === "open") {
    if (card.options.length < 2 || card.options.length > 5) throw problem("CARD_OPTIONS_REQUIRED");
    card.options.forEach((option, index) => {
      const label = clean(card, option);
      const number = index + 1;
      const recommended = index === card.recommend;
      const long = label.length > 24 || /[\r\n]/.test(label);
      if (long) elements.push(block(`${number}. ${label}`));
      elements.push({
        tag: "button",
        text: plain(`${long ? `选择第 ${number} 项` : `${number}. ${label}`}${recommended ? "（建议）" : ""}`),
        type: recommended ? "primary_filled" : "default",
        width: "fill",
        behaviors: [
          { type: "callback", value: { personalLoopDecision: 1, card: card.id, choice: index, version: card.version } },
        ],
      });
    });
  } else elements.push(...outcome(card).map(block));
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: { title: plain(`${heading(card)} #${card.id}`), template: card.state === "open" ? "blue" : "grey" },
    body: { direction: "vertical", elements },
  };
}

// Keep the submitted result intact, and lift only a short source sentence into the phone preview.
export function renderResultCard(card: Card) {
  if (
    card.kind !== "notice" ||
    !Number.isSafeInteger(card.id) ||
    card.id < 1 ||
    !Number.isSafeInteger(card.version) ||
    card.version < 1
  )
    throw problem("INVALID_RESULT_CARD");
  const plain = (content: string) => ({ tag: "plain_text", content });
  const block = (content: string) => ({ tag: "div", text: plain(content) });
  const fullTitle = clean(card, card.title);
  const chars = [...fullTitle];
  const title = chars.length <= 72 ? fullTitle : chars.slice(0, 71).join("") + "…";
  const body = [
    ...(title !== fullTitle ? [fullTitle] : []),
    clean(card, card.text),
    ...(card.result?.trim() ? ["处理说明：" + clean(card, card.result)] : []),
  ]
    .filter(Boolean)
    .join("\n");
  const elements: Record<string, unknown>[] = [];
  const lines = body.trim().split(/\r?\n/);
  const technical =
    /[|｜`]|https?:\/\/|(?:^|[\s(])(?:~\/|\/|\.\/)|\b[\w.-]+\.(?:md|json|yaml|yml|ts|py|log)\b|[a-f\d]{32,}/iu;
  if ([...body].length <= 96 && lines.length <= 2 && !technical.test(body)) {
    if (body.trim() && body.trim() !== title.trim()) elements.push(block(body));
  } else {
    const candidates = body
      .replace(/```[\s\S]*?(?:```|$)/g, "\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => !/^(?:[#>*\[-]|\d+[.、)]|证据|来源|依据)/u.test(line))
      .map((line) => line.match(/^.{3,79}?[。！？!?]/u)?.[0] ?? "")
      .filter((s) => s && !technical.test(s) && !title.includes(s));
    const snippet = candidates.find((s) => /^(?:建议|下一步|目前|需要你|先)/u.test(s)) ?? candidates[0];
    if (snippet) elements.push(block(snippet));
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: { title: plain("查看完整结果") },
      elements: [block(body)],
    });
  }
  if (!elements.length) elements.push(block("无需回复"));
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false, summary: { content: title } },
    header: { title: plain(title), template: card.state === "closed" ? "grey" : "blue" },
    body: { direction: "vertical", elements },
  };
}

function configuration(options: Record<string, unknown>) {
  const { profile, chatId, lark, deliveryNamespace } = options;
  if (typeof profile !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(profile))
    throw problem("FEISHU_GROUP_PROFILE_REQUIRED");
  if (typeof chatId !== "string" || !/^oc_[A-Za-z0-9_-]+$/.test(chatId)) throw problem("FEISHU_GROUP_CHAT_REQUIRED");
  if (typeof deliveryNamespace !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(deliveryNamespace))
    throw problem("FEISHU_DELIVERY_NAMESPACE_REQUIRED");
  if (lark !== undefined && (typeof lark !== "string" || !path.isAbsolute(lark)))
    throw problem("FEISHU_GROUP_CLI_PATH_INVALID");
  const { interactiveAsks = false, interactiveAsksFromId = 1 } = options;
  if (
    typeof interactiveAsks !== "boolean" ||
    typeof interactiveAsksFromId !== "number" ||
    !Number.isSafeInteger(interactiveAsksFromId) ||
    interactiveAsksFromId < 1
  )
    throw problem("FEISHU_INTERACTIVE_ASK_CONFIG_INVALID");
  const resultCutoff = options.interactiveResultsFromId;
  if (
    resultCutoff !== undefined &&
    (typeof resultCutoff !== "number" || !Number.isSafeInteger(resultCutoff) || resultCutoff < 1)
  )
    throw problem("FEISHU_INTERACTIVE_RESULT_CONFIG_INVALID");
  const deliveryPrefix = `pl-card-${createHash("sha256")
    .update(JSON.stringify([deliveryNamespace, chatId]))
    .digest("hex")
    .slice(0, 20)}-`;
  return {
    profile,
    chatId,
    deliveryPrefix,
    program: (lark as string | undefined) ?? "lark-cli",
    interactiveAsks,
    interactiveAsksFromId,
    resultCutoff,
  };
}

function call(program: string, args: string[], body: string, signal: AbortSignal): Promise<unknown> {
  if (Buffer.byteLength(body, "utf8") > 25000) throw problem("FEISHU_TEXT_TOO_LONG");
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      { encoding: "utf8", timeout: 30000, maxBuffer: 1048576, signal },
      (error, stdout) => {
        if (error) return reject(problem("FEISHU_CLI_FAILED"));
        try {
          const result = JSON.parse(stdout);
          if (!result || result.ok !== true) return reject(problem("FEISHU_RESPONSE_NOT_OK"));
          resolve(result.data);
        } catch {
          reject(problem("FEISHU_RESPONSE_INVALID"));
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(body);
  });
}

export default async function groupText({ hub, options, log, signal }: ChannelContext) {
  const { program, profile, chatId, deliveryPrefix, interactiveAsks, interactiveAsksFromId, resultCutoff } =
    configuration(options);
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch {
      if (signal.aborted) return;
      log("飞书群通道暂时无法读取待发事项");
      await wait(1000, undefined, { signal }).catch(() => {});
      continue;
    }
    if (!card || signal.aborted) continue;
    try {
      if (card.ref !== null && !messageId(card.ref)) throw problem("FEISHU_MESSAGE_REF_INVALID");
      const interactive =
        card.kind === "ask"
          ? interactiveAsks && card.id >= interactiveAsksFromId
          : resultCutoff !== undefined && card.id >= resultCutoff;
      const content = interactive
        ? JSON.stringify(card.kind === "ask" ? renderDecisionCard(card) : renderResultCard(card))
        : null;
      const args = ["--profile", profile, "im"];
      let body: string;
      if (content && card.ref) {
        args.push("messages", "patch", "--message-id", card.ref, "--as", "bot", "--data", "-");
        body = JSON.stringify({ content });
      } else {
        if (card.ref) args.push("+messages-edit", "--message-id", card.ref);
        else args.push("+messages-send", "--chat-id", chatId);
        args.push("--as", "bot");
        if (content) {
          args.push("--msg-type", "interactive", "--content", "-");
          body = content;
        } else {
          args.push("--text", "-");
          body = renderText(card);
        }
      }
      if (!card.ref) args.push("--idempotency-key", `${deliveryPrefix}${card.id}`);
      const data = (await call(program, args, body, signal)) as { message_id?: unknown; chat_id?: unknown } | undefined;
      if (data?.chat_id !== undefined && data.chat_id !== chatId) throw problem("FEISHU_CHAT_REF_MISMATCH");
      const returned = data?.message_id;
      if (card.ref && returned !== undefined && returned !== card.ref) throw problem("FEISHU_MESSAGE_REF_MISMATCH");
      const ref = card.ref ?? returned;
      if (!messageId(ref)) throw problem("FEISHU_MESSAGE_REF_MISSING");
      await hub.delivered(card.id, card.version, ref);
    } catch {
      if (signal.aborted) return;
      const summary = "飞书消息尚未确认送达，请检查群通道连接与权限";
      log(`事项 #${card.id}：${summary}`);
      await hub.failed(card.id, card.version, summary).catch(() => {});
    }
  }
}
