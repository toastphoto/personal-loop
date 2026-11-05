import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCatalog, readConfig } from "./factory.mjs";
import { LoopControls } from "./controls.mjs";
import { RelayQueue } from "./relay-queue.mjs";
import { parseLoopCommand, handleLoopCommand } from "./feishu-commands.mjs";
import { failure, safeError } from "./catalog.mjs";
import { NativeLoopRuntime } from "./loop-runtime.mjs";
import { startLoopHub } from "./hub-host.mjs";
import { commandText, routeProjectMessage, readRouting } from "./feishu-route.mjs";
export { commandText } from "./feishu-route.mjs";
import { CardSessions, ProjectCardController } from "./feishu-card-control.mjs";
import { CardEventSubscriber } from "./callback-consumer.mjs";
import { FeishuCardRelay } from "./feishu-card-relay.mjs";
import { ProjectActivity } from "./project-activity.mjs";
import { renderProjectCard } from "./feishu-project-card.mjs";

export function acceptsCommand(event, config) {
  return (
    event?.chat_id === config.chatId &&
    config.allowedSenderIds?.includes(event.sender_id) &&
    event.sender_type === "user" &&
    event.message_type === "text" &&
    typeof event.message_id === "string" &&
    /^om_[A-Za-z0-9_-]{1,160}$/.test(event.message_id) &&
    routeProjectMessage(event, config.naturalRoutingFile ? readRouting(config.naturalRoutingFile) : {}) === "loop"
  );
}
export function runProgram(program, args, { input = "", timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      program,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      },
      (error, stdout) => {
        resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
// Persist the final display payload with the command result, before any delivery attempt.
export function projectReply(result, config) {
  if (
    config.projectCards?.enabled !== true ||
    result.ok !== true ||
    !["project-directory", "project-status"].includes(result.view?.kind)
  )
    return result.text;
  // Native folding works without callbacks. Do not publish unverified server-side buttons.
  return { type: "interactive", card: renderProjectCard(result.view, undefined, { interactive: false }) };
}

export async function larkReply(config, item, execute = runProgram) {
  if (!acceptsCommand(item.event, config) || item.id !== item.event.message_id) throw failure("REPLY_SCOPE_MISMATCH");
  const card = item.response?.type === "interactive" ? item.response.card : null;
  let input;
  if (typeof item.response === "string") {
    if (Buffer.byteLength(item.response) > 24000) throw failure("INVALID_REPLY");
    input = item.response;
  } else {
    if (!card || card.schema !== "2.0" || !Array.isArray(card.body?.elements)) throw failure("INVALID_REPLY");
    input = JSON.stringify(card);
    if (Buffer.byteLength(input) > 28000) throw failure("INVALID_REPLY");
  }
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(item.deliveryKey)) throw failure("INVALID_REPLY");
  const result = await execute(
    config.larkCommand ?? "lark-cli",
    [
      "--profile",
      config.profile,
      "im",
      "+messages-reply",
      "--message-id",
      item.id,
      "--idempotency-key",
      item.deliveryKey,
      "--as",
      "bot",
      ...(card ? ["--msg-type", "interactive", "--content", "-"] : ["--text", "-"]),
    ],
    { input, timeoutMs: 30000 },
  );
  if (result.exitCode !== 0) throw failure("REPLY_UNCONFIRMED");
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw failure("REPLY_UNCONFIRMED");
  }
  const data = body.data ?? body;
  if (body.ok === false || !data.message_id || (data.chat_id && data.chat_id !== config.chatId))
    throw failure("REPLY_UNCONFIRMED");
  return data.message_id;
}

export class FeishuLoopRelay {
  constructor(config, { queue, catalog, controls, reply, readiness, syncRules, answerCard, cards } = {}) {
    if (
      !config?.chatId ||
      !Array.isArray(config.allowedSenderIds) ||
      !config.allowedSenderIds.length ||
      !config.profile
    )
      throw failure("RELAY_AUTHORIZATION_REQUIRED");
    this.config = config;
    this.queue = queue;
    this.catalog = catalog;
    this.controls = controls;
    this.reply = reply ?? ((item) => larkReply(config, item));
    this.readiness = readiness ?? (async () => ({ ready: false, rulesReady: false }));
    this.syncRules = syncRules;
    this.answerCard = answerCard;
    this.cards = cards;
    this.stopping = false;
    this.editedCommandsIgnored = 0;
  }
  filter(event) {
    if (!acceptsCommand(event, this.config)) return false;
    const prior = this.queue.get(event.message_id) ?? this.batch?.get(event.message_id);
    if (prior && prior.event.content !== event.content) {
      this.editedCommandsIgnored++;
      return false;
    }
    this.batch?.set(event.message_id, { event });
    return true;
  }
  async tick({ sendReplies = true } = {}) {
    this.batch = new Map();
    const ingest = this.queue.ingest(this.config.queuePath, {
      initialOffset: "tail",
      filter: (event) => this.filter(event),
    });
    for (const item of this.queue.pending({ limit: 10 })) {
      if (this.stopping) break;
      if (!acceptsCommand(item.event, this.config)) {
        this.queue.discard(item.id, "SCOPE_REVOKED");
        continue;
      }
      try {
        let command;
        let result;
        let directorySnapshot;
        const requestCatalog = {
          refresh: async () => {
            directorySnapshot = await this.catalog.refresh();
            return directorySnapshot;
          },
        };
        try {
          command = parseLoopCommand(commandText(item.event));
        } catch (error) {
          result = {
            ok: false,
            code: error.code ?? "LOOP_COMMAND_USAGE",
            text: error.userMessage ?? "项目指令格式不正确，请使用 /loop 项目 查看说明。",
          };
        }
        if (!result && !command && this.cards) result = await this.cards.natural(item, commandText(item.event));
        if (!result)
          result = await handleLoopCommand(command, {
            catalog: requestCatalog,
            controls: this.controls,
            actor: item.event.sender_id,
            requestId: item.requestId,
            readiness: this.readiness,
            syncRules: this.syncRules,
            answerCard: this.answerCard,
          });
        const prepared =
          result.response ?? (this.cards ? await this.cards.prepare(item, result, directorySnapshot) : null);
        const { response: unused, ...savedResult } = result;
        this.queue.saveResult(item.id, savedResult, prepared ?? projectReply(result, this.config));
      } catch (error) {
        this.queue.markFailure(item.id, "handling", safeError(error), { retryAfterMs: this.config.retryMs ?? 15000 });
      }
    }
    if (sendReplies)
      for (const item of this.queue.pendingReplies({ limit: 10 })) {
        if (this.stopping) break;
        if (!acceptsCommand(item.event, this.config)) {
          this.queue.discard(item.id, "SCOPE_REVOKED");
          continue;
        }
        if (item.replyAttempts >= (this.config.maxReplyAttempts ?? 3)) {
          this.queue.markReplyAbandoned(item.id, "REPLY_RETRIES_EXHAUSTED");
          continue;
        }
        try {
          const ref = await this.reply(item);
          if (item.response?.sessionId && this.cards) this.cards.bind(item.response.sessionId, ref);
          this.queue.markReply(item.id, ref);
        } catch (error) {
          const failed = this.queue.markFailure(item.id, "reply", safeError(error), {
            retryAfterMs: this.config.retryMs ?? Math.min(60000, 5000 * 2 ** item.replyAttempts),
          });
          if (failed.replyAttempts >= (this.config.maxReplyAttempts ?? 3))
            this.queue.markReplyAbandoned(item.id, "REPLY_RETRIES_EXHAUSTED");
        }
      }
    return {
      observedAt: new Date().toISOString(),
      ingest,
      queue: this.queue.stats(),
      editedCommandsIgnored: this.editedCommandsIgnored,
    };
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) throw failure("RELAY_CONFIG_REQUIRED");
  const config = JSON.parse(readFileSync(file, "utf8"));
  const native = readConfig(config.nativeConfigFile);
  const catalog = createCatalog(native);
  const controls = new LoopControls(native.controlsFile);
  const queue = new RelayQueue(config.databaseFile);
  const runtime = native.loopHub
    ? new NativeLoopRuntime({ nativeConfig: native, configFile: config.nativeConfigFile, controls })
    : null;
  const hub = !process.argv.includes("--once") ? await startLoopHub(native) : { stop: async () => {}, ready: false };
  let subscriber, callbackQueue, callbackRelay, cards, cardStore, wake;
  if (config.cardCallbacks?.enabled === true && !process.argv.includes("--once")) {
    const c = { ...config, ...config.cardCallbacks };
    try {
      cardStore = new CardSessions(c.sessionsFile);
      subscriber = new CardEventSubscriber(c, { onEvent: () => wake?.() });
      await subscriber.start();
      callbackQueue = new RelayQueue(c.databaseFile);
      cards = new ProjectCardController(config, {
        store: cardStore,
        catalog,
        controls,
        runtime,
        activity:
          config.projectActivity?.enabled === true ? new ProjectActivity(catalog, config.projectActivity) : undefined,
        transportReady: () => subscriber.status().ready,
      });
      callbackRelay = new FeishuCardRelay(c, { queue: callbackQueue, controller: cards, execute: runProgram });
    } catch (error) {
      await subscriber?.stop();
      callbackQueue?.close();
      cardStore?.close();
      queue.close();
      await catalog.close();
      await hub.stop();
      throw error;
    }
  }
  const relay = new FeishuLoopRelay(config, {
    queue,
    catalog,
    controls,
    cards,
    ...(runtime
      ? {
          readiness: (project) => runtime.readiness(project),
          syncRules: (args) => runtime.sync(args),
          answerCard: (args) => runtime.answerCard(args),
        }
      : {}),
  });
  const once = process.argv.includes("--once");
  const noReply = process.argv.includes("--no-reply");
  const statusFile = config.statusFile;
  const record = (value) => {
    if (!statusFile) return;
    mkdirSync(path.dirname(statusFile), { recursive: true, mode: 0o700 });
    writeFileSync(statusFile + ".tmp", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(statusFile + ".tmp", statusFile);
  };
  process.on("SIGTERM", () => {
    relay.stopping = true;
    wake?.();
  });
  process.on("SIGINT", () => {
    relay.stopping = true;
    wake?.();
  });
  try {
    do {
      try {
        const callbackState = callbackRelay ? await callbackRelay.tick() : undefined;
        record({
          status: "ready",
          ...(await relay.tick({ sendReplies: !noReply })),
          ...(subscriber
            ? { callbacks: { ...subscriber.status(), verified: cards.enabled(), queue: callbackState?.queue } }
            : {}),
        });
        if (subscriber && !subscriber.status().ready) throw failure("CARD_SUBSCRIBER_STOPPED");
      } catch (error) {
        record({ status: "blocked", errorCode: safeError(error), observedAt: new Date().toISOString() });
        if (once || error.code === "CARD_SUBSCRIBER_STOPPED") throw error;
      }
      if (once || relay.stopping) break;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, 2000);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    } while (!relay.stopping);
  } finally {
    await subscriber?.stop();
    callbackQueue?.close();
    cardStore?.close();
    queue.close();
    await catalog.close();
    await hub.stop();
    record({ status: "stopped", observedAt: new Date().toISOString() });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: safeError(error) }));
    process.exitCode = 1;
  });
}
