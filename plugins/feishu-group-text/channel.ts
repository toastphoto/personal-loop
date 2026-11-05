// Plain-text group delivery only. Replies arrive through the existing relay, never a second event listener.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { Card, ChannelContext } from "../../host/channels.ts";

const problem = (code: string) => Object.assign(new Error(code), { code });
const messageId = (value: unknown): value is string => typeof value === "string" && /^om_[A-Za-z0-9_-]+$/.test(value);

export function renderText(card: Card): string {
  if (!Number.isSafeInteger(card.id) || card.id < 1) throw problem("INVALID_CARD_ID");
  const clean = (value: string | null) => {
    let text = value ?? "";
    if (card.link) text = text.split(card.link).join("[授权链接已隐藏]");
    return text.replaceAll("<", "＜").replaceAll(">", "＞");
  };
  const heading =
    card.state === "open"
      ? card.kind === "ask"
        ? "待你决定"
        : "进展通知"
      : card.state === "decided"
        ? "决定已记录，等待处理"
        : card.state === "done"
          ? "处理结果"
          : "事项已结案";
  const lines = [`${heading} #${card.id}`, clean(card.title), clean(card.text)];
  if (card.state === "open" && card.kind === "ask") {
    if (!card.options.length) throw problem("CARD_OPTIONS_REQUIRED");
    lines.push(
      ...card.options.map(
        (option, index) => `${index + 1}. ${clean(option)}${index === card.recommend ? "（建议）" : ""}`,
      ),
    );
    lines.push(`请选择上面的编号，例如：/loop 回答 ${card.id} 1`);
  } else if (card.state === "open") lines.push("无需回复");
  else {
    const chosen = card.choice === null ? card.answer : card.options[card.choice];
    if (chosen) lines.push(`你的选择：${clean(chosen)}`);
    if (card.state === "decided") lines.push("决定已收到，尚未确认执行完成");
    else if (card.result) lines.push(`结果：${clean(card.result)}`);
  }
  return lines.filter(Boolean).join("\n");
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
  const deliveryPrefix = `pl-card-${createHash("sha256")
    .update(JSON.stringify([deliveryNamespace, chatId]))
    .digest("hex")
    .slice(0, 20)}-`;
  return { profile, chatId, deliveryPrefix, program: (lark as string | undefined) ?? "lark-cli" };
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
  const { program, profile, chatId, deliveryPrefix } = configuration(options);
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
      const args = ["--profile", profile, "im", card.ref ? "+messages-edit" : "+messages-send"];
      if (card.ref) args.push("--message-id", card.ref);
      else args.push("--chat-id", chatId);
      args.push("--as", "bot", "--text", "-");
      if (!card.ref) args.push("--idempotency-key", `${deliveryPrefix}${card.id}`);
      const data = (await call(program, args, renderText(card), signal)) as
        { message_id?: unknown; chat_id?: unknown } | undefined;
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
