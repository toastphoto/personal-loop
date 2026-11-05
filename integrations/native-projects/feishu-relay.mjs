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

export function commandText(event) {
  if (typeof event?.content !== "string") return "";
  let text = event.content.trim();
  const prefixes = (Array.isArray(event.mentions) ? event.mentions : [])
    .slice(0, 50)
    .flatMap((mention) => {
      if (!mention || typeof mention !== "object") return [];
      return [
        typeof mention.key === "string" ? mention.key : null,
        typeof mention.name === "string" ? "@" + mention.name : null,
      ].filter(Boolean);
    })
    .sort((a, b) => b.length - a.length);
  for (let count = 0; count < 50; count++) {
    const prefix = prefixes.find((p) => text.startsWith(p) && (text.length === p.length || /\s/.test(text[p.length])));
    if (!prefix) break;
    text = text.slice(prefix.length).trimStart();
  }
  return text;
}

export function acceptsCommand(event, config) {
  return (
    event?.chat_id === config.chatId &&
    config.allowedSenderIds?.includes(event.sender_id) &&
    event.sender_type === "user" &&
    event.message_type === "text" &&
    typeof event.message_id === "string" &&
    /^om_[A-Za-z0-9_-]{1,160}$/.test(event.message_id) &&
    /^\/?loop(?:\s|$)/i.test(commandText(event))
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
export async function larkReply(config, item, execute = runProgram) {
  if (!acceptsCommand(item.event, config) || item.id !== item.event.message_id) throw failure("REPLY_SCOPE_MISMATCH");
  if (
    typeof item.response !== "string" ||
    Buffer.byteLength(item.response) > 24000 ||
    !/^[A-Za-z0-9_-]{1,50}$/.test(item.deliveryKey)
  )
    throw failure("INVALID_REPLY");
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
      "--text",
      "-",
    ],
    { input: item.response, timeoutMs: 30000 },
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
  constructor(config, { queue, catalog, controls, reply, readiness, syncRules, answerCard } = {}) {
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
        try {
          command = parseLoopCommand(commandText(item.event));
        } catch (error) {
          result = {
            ok: false,
            code: error.code ?? "LOOP_COMMAND_USAGE",
            text: error.userMessage ?? "项目指令格式不正确，请使用 /loop 项目 查看说明。",
          };
        }
        if (!result)
          result = await handleLoopCommand(command, {
            catalog: this.catalog,
            controls: this.controls,
            actor: item.event.sender_id,
            requestId: item.requestId,
            readiness: this.readiness,
            syncRules: this.syncRules,
            answerCard: this.answerCard,
          });
        this.queue.saveResult(item.id, result, result.text);
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
          this.queue.markReply(item.id, await this.reply(item));
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
  const relay = new FeishuLoopRelay(config, {
    queue,
    catalog,
    controls,
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
  });
  process.on("SIGINT", () => {
    relay.stopping = true;
  });
  try {
    do {
      try {
        record({ status: "ready", ...(await relay.tick({ sendReplies: !noReply })) });
      } catch (error) {
        record({ status: "blocked", errorCode: safeError(error), observedAt: new Date().toISOString() });
        if (once) throw error;
      }
      if (once || relay.stopping) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (!relay.stopping);
  } finally {
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
