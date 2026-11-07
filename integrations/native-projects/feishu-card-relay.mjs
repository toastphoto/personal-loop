import { failure, safeError } from "./catalog.mjs";
export function acceptsCardEvent(event, config) {
  return (
    event?.sender_type === "user" &&
    event.message_type === "card_action" &&
    event.chat_id === config.chatId &&
    config.allowedSenderIds.includes(event.sender_id)
  );
}
export async function patchProjectCard(config, response, execute) {
  if (
    response?.type !== "interactive" ||
    !/^om_[A-Za-z0-9_-]+$/.test(response.messageId ?? "") ||
    response.card?.schema !== "2.0"
  )
    throw failure("CARD_PATCH_INVALID");
  const content = JSON.stringify(response.card);
  if (Buffer.byteLength(content) > 28000) throw failure("CARD_PATCH_INVALID");
  const result = await execute(
    config.larkCommand ?? "lark-cli",
    [
      "--profile",
      config.profile,
      "im",
      "messages",
      "patch",
      "--message-id",
      response.messageId,
      "--as",
      "bot",
      "--data",
      "-",
    ],
    { input: JSON.stringify({ content }), timeoutMs: 30000 },
  );
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw failure("CARD_PATCH_UNCONFIRMED");
  }
  if (result.exitCode !== 0 || body.ok !== true) throw failure("CARD_PATCH_UNCONFIRMED");
  return response.messageId;
}
export class FeishuCardRelay {
  constructor(config, { queue, controller, execute, answerDecisionClick, checkpointCards }) {
    Object.assign(this, { config, queue, controller, execute, answerDecisionClick, checkpointCards });
  }
  async tick() {
    const ingest = this.queue.ingest(this.config.queuePath, {
      initialOffset: 0,
      filter: (e) => acceptsCardEvent(e, this.config),
    });
    for (const item of this.queue.pending({ limit: 10 })) {
      if (!acceptsCardEvent(item.event, this.config)) {
        this.queue.discard(item.id, "SCOPE_REVOKED");
        continue;
      }
      try {
        const data = JSON.parse(item.event.content);
        let action;
        try {
          action = JSON.parse(data.actionValue);
        } catch {
          /* Navigation and form callbacks may have no value. */
        }
        if (action && Object.hasOwn(action, "personalLoopCheckpoint")) {
          if (
            !this.checkpointCards ||
            action.personalLoopCheckpoint !== 1 ||
            data.host !== "im_message" ||
            data.actionTag !== "button"
          )
            throw failure("CARD_ACTION_INVALID");
          const result = await this.checkpointCards.handle({
            id: action.id,
            version: action.version,
            choice: action.choice,
            actor: item.event.sender_id,
            chat: item.event.chat_id,
            messageId: data.cardMessageId,
            requestId: item.requestId,
            profile: this.config.profile,
          });
          if (!result?.ok) this.queue.discard(item.id, result?.code ?? "CARD_ACTION_INVALID");
          else this.queue.saveResult(item.id, { ok: true }, { type: "checkpoint-handled" });
          continue;
        }
        if (action && Object.hasOwn(action, "personalLoopDecision")) {
          if (
            !this.answerDecisionClick ||
            action.personalLoopDecision !== 1 ||
            data.host !== "im_message" ||
            data.actionTag !== "button" ||
            !/^om_[A-Za-z0-9_-]{1,160}$/.test(data.cardMessageId ?? "") ||
            !Number.isSafeInteger(action.card) ||
            action.card < 1 ||
            !Number.isSafeInteger(action.version) ||
            action.version < 1 ||
            !Number.isSafeInteger(action.choice) ||
            action.choice < 0
          )
            throw failure("CARD_ACTION_INVALID");
          const result = await this.answerDecisionClick({
            cardId: action.card,
            choice: action.choice,
            version: action.version,
            actor: item.event.sender_id,
            messageId: data.cardMessageId,
            requestId: item.requestId,
            profile: this.config.profile,
            chatId: this.config.chatId,
          });
          if (!result?.ok) this.queue.discard(item.id, result?.code ?? "CARD_ACTION_INVALID");
          else this.queue.saveResult(item.id, { ok: true }, { type: "hub-decision" });
          continue;
        }
        const response = await this.controller.handle({
          ...data,
          actor: item.event.sender_id,
          chat: item.event.chat_id,
        });
        this.queue.saveResult(item.id, { ok: true }, response);
      } catch (error) {
        const code = safeError(error);
        if (
          [
            "CARD_SCOPE_MISMATCH",
            "CARD_ACTION_INVALID",
            "CARD_ACTION_NOT_ISSUED",
            "CARD_EVENT_CONFLICT",
            "CARD_GOAL_INVALID",
          ].includes(code)
        )
          this.queue.discard(item.id, code);
        else this.queue.markFailure(item.id, "handling", code, { retryAfterMs: 5000 });
      }
    }
    for (const item of this.queue.pendingReplies({ limit: 10 })) {
      if (!acceptsCardEvent(item.event, this.config)) {
        this.queue.discard(item.id, "SCOPE_REVOKED");
        continue;
      }
      // The hub owns decision card revisions and delivers the chosen option and final result.
      if (item.response?.type === "hub-decision" || item.response?.type === "checkpoint-handled") {
        this.queue.markReply(item.id, "handled-by-hub");
        continue;
      }
      if (!this.controller.current(item.response)) {
        this.queue.markReply(item.id, "superseded");
        continue;
      }
      try {
        const id = await patchProjectCard(this.config, item.response, this.execute);
        this.queue.markReply(item.id, id);
      } catch (error) {
        const next = this.queue.markFailure(item.id, "reply", safeError(error), { retryAfterMs: 5000 });
        if (next.replyAttempts >= 3) this.queue.markReplyAbandoned(item.id, "CARD_PATCH_RETRIES_EXHAUSTED");
      }
    }
    return { ingest, queue: this.queue.stats() };
  }
}
