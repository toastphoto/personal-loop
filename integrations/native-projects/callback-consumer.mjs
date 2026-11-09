import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, mkdirSync, lstatSync, openSync, fstatSync, closeSync, writeSync, fsyncSync } from "node:fs";
import path from "node:path";

const fail = (code) => Object.assign(new Error(code), { code });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_LINE_BYTES = 1048576;
const MAX_DIAGNOSTIC_BYTES = 65536;
const decoder = new TextDecoder("utf-8", { fatal: true });
const identifier = (value, prefix) =>
  typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,160}$`).test(value);
const eventId = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const boundedString = (value, max) => typeof value === "string" && Buffer.byteLength(value) <= max;
const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;

function normalize(event, config, owners) {
  if (
    !object(event) ||
    event.type !== "card.action.trigger" ||
    event.chat_id !== config.chatId ||
    !owners.has(event.operator_id) ||
    event.host !== "im_message" ||
    !eventId(event.event_id) ||
    !identifier(event.message_id, "om") ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(event.action_tag ?? "")
  )
    return null;
  const fields = [
    ["action_value", 32768],
    ["action_name", 256],
    ["form_value", 32768],
    ["option", 512],
  ];
  for (const [key, limit] of fields) if (event[key] !== undefined && !boundedString(event[key], limit)) return null;
  const content = {
    eventId: event.event_id,
    cardMessageId: event.message_id,
    host: event.host,
    actionTag: event.action_tag,
    actionValue: event.action_value ?? "",
    actionName: event.action_name ?? "",
    formValue: event.form_value ?? "",
    option: event.option ?? "",
  };
  return {
    message_id: "cb_" + createHash("sha256").update(event.event_id).digest("hex"),
    sender_id: event.operator_id,
    sender_type: "user",
    chat_id: event.chat_id,
    message_type: "card_action",
    content: JSON.stringify(content),
  };
}

// The official consumer attaches to its profile's shared event bus; this class owns only that child.
export class CardEventSubscriber {
  #config;
  #owners;
  #spawn;
  #append;
  #onEvent;
  #readyTimeout;
  #stopTimeout;
  #child = null;
  #fd = null;
  #queueIdentity = null;
  #phase = "idle";
  #ready = false;
  #counts = { received: 0, accepted: 0, dropped: 0, errors: 0 };
  #errorCode = null;
  #output = Buffer.alloc(0);
  #diagnostics = Buffer.alloc(0);
  #early = [];
  #readyTimer;
  #startPromise;
  #resolveStart;
  #rejectStart;
  #startSettled = false;
  #closed;
  #resolveClosed;
  #stopPromise;
  #requestedStop = false;
  #terminationSent = false;
  constructor(config, { spawn = spawnProcess, append, onEvent, readyTimeoutMs = 15000, stopTimeoutMs = 5000 } = {}) {
    if (
      !object(config) ||
      typeof config.profile !== "string" ||
      !config.profile.trim() ||
      config.profile.startsWith("-") ||
      config.profile.includes("\0") ||
      config.profile.length > 256 ||
      !identifier(config.chatId, "oc") ||
      !Array.isArray(config.allowedSenderIds) ||
      !config.allowedSenderIds.length ||
      config.allowedSenderIds.length > 100 ||
      config.allowedSenderIds.some((id) => !identifier(id, "ou")) ||
      typeof config.queuePath !== "string" ||
      !path.isAbsolute(config.queuePath) ||
      config.queuePath.includes("\0") ||
      typeof process.getuid !== "function"
    )
      throw fail("CARD_CONSUMER_INVALID_CONFIG");
    if (
      !positive(readyTimeoutMs, 60000) ||
      !positive(stopTimeoutMs, 30000) ||
      typeof spawn !== "function" ||
      (append !== undefined && typeof append !== "function") ||
      (onEvent !== undefined && typeof onEvent !== "function")
    )
      throw fail("CARD_CONSUMER_INVALID_CONFIG");
    const command = config.larkCommand ?? "lark-cli";
    if (typeof command !== "string" || !command || command.includes("\0")) throw fail("CARD_CONSUMER_INVALID_CONFIG");
    this.#config = {
      profile: config.profile,
      larkCommand: command,
      chatId: config.chatId,
      queuePath: path.resolve(config.queuePath),
    };
    this.#owners = new Set(config.allowedSenderIds);
    this.#spawn = spawn;
    this.#append = append;
    this.#onEvent = onEvent;
    this.#readyTimeout = readyTimeoutMs;
    this.#stopTimeout = stopTimeoutMs;
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }
  status() {
    return { ready: this.#ready, ...this.#counts, errorCode: this.#errorCode };
  }
  #privateParent() {
    const parent = lstatSync(path.dirname(this.#config.queuePath));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid() ||
      (parent.mode & 0o777) !== 0o700
    )
      throw fail("CARD_QUEUE_PRIVATE_DIRECTORY_REQUIRED");
    return parent;
  }
  #privateFile(value) {
    if (!value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid() || (value.mode & 0o777) !== 0o600)
      throw fail("CARD_QUEUE_PRIVATE_FILE_REQUIRED");
  }
  #prepareQueue() {
    mkdirSync(path.dirname(this.#config.queuePath), { recursive: true, mode: 0o700 });
    const parent = this.#privateParent();
    let old;
    try {
      old = lstatSync(this.#config.queuePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (old) this.#privateFile(old);
    this.#fd = openSync(
      this.#config.queuePath,
      constants.O_WRONLY |
        constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0) |
        (old ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    const opened = fstatSync(this.#fd);
    this.#privateFile(opened);
    this.#queueIdentity = { dev: opened.dev, ino: opened.ino, parentDev: parent.dev, parentIno: parent.ino };
    this.#checkQueue();
  }
  #checkQueue() {
    const parent = this.#privateParent();
    const file = lstatSync(this.#config.queuePath);
    this.#privateFile(file);
    const opened = fstatSync(this.#fd);
    this.#privateFile(opened);
    if (
      file.dev !== this.#queueIdentity.dev ||
      file.ino !== this.#queueIdentity.ino ||
      opened.dev !== file.dev ||
      opened.ino !== file.ino ||
      parent.dev !== this.#queueIdentity.parentDev ||
      parent.ino !== this.#queueIdentity.parentIno
    )
      throw fail("CARD_QUEUE_CHANGED");
  }
  #closeQueue() {
    if (this.#fd !== null) {
      try {
        closeSync(this.#fd);
      } catch {}
      this.#fd = null;
    }
  }
  #settleStart(error) {
    if (this.#startSettled) return;
    this.#startSettled = true;
    clearTimeout(this.#readyTimer);
    if (error) this.#rejectStart?.(fail(error));
    else this.#resolveStart?.(this.status());
  }
  #terminateOwnChild() {
    if (!this.#child || this.#terminationSent) return;
    this.#terminationSent = true;
    try {
      this.#child.kill("SIGTERM");
    } catch {}
    try {
      this.#child.stdin?.end();
    } catch {}
  }
  #fatal(code) {
    if (["closed", "stopping"].includes(this.#phase)) return;
    this.#ready = false;
    this.#errorCode = code;
    this.#counts.errors++;
    this.#phase = "stopping";
    this.#counts.dropped += this.#early.length;
    this.#early = [];
    this.#settleStart(code);
    this.#terminateOwnChild();
    if (!this.#child) this.#finishExit(null, null);
  }
  #finishExit(code, signal) {
    if (this.#phase === "closed") return;
    this.#ready = false;
    if (!this.#requestedStop && !this.#errorCode) {
      this.#errorCode =
        Number.isSafeInteger(code) && code >= 0
          ? `CARD_CONSUMER_EXIT_${code}`
          : signal
            ? "CARD_CONSUMER_SIGNAL_EXIT"
            : "CARD_CONSUMER_EXITED";
      this.#counts.errors++;
    }
    this.#settleStart(this.#errorCode ?? "CARD_CONSUMER_STOPPED");
    this.#counts.dropped += this.#early.length;
    this.#early = [];
    this.#output = Buffer.alloc(0);
    this.#diagnostics = Buffer.alloc(0);
    this.#closeQueue();
    this.#phase = "closed";
    this.#resolveClosed(this.status());
  }
  #save(row) {
    try {
      this.#checkQueue();
      const line = JSON.stringify(row) + "\n";
      if (this.#append) {
        const returned = this.#append(line);
        if (returned && typeof returned.then === "function") {
          Promise.resolve(returned).catch(() => {});
          throw fail("CARD_QUEUE_ASYNC_APPEND_UNSUPPORTED");
        }
      } else {
        const bytes = Buffer.from(line);
        if (writeSync(this.#fd, bytes) !== bytes.length) throw fail("CARD_QUEUE_INCOMPLETE_WRITE");
        fsyncSync(this.#fd);
      }
      this.#counts.accepted++;
    } catch (error) {
      const known = new Set([
        "CARD_QUEUE_PRIVATE_DIRECTORY_REQUIRED",
        "CARD_QUEUE_PRIVATE_FILE_REQUIRED",
        "CARD_QUEUE_CHANGED",
        "CARD_QUEUE_ASYNC_APPEND_UNSUPPORTED",
        "CARD_QUEUE_INCOMPLETE_WRITE",
      ]);
      this.#fatal(known.has(error.code) ? error.code : "CARD_QUEUE_WRITE_FAILED");
      return;
    }
    // Waking the parent cannot undo persistence or cause the event to be appended again.
    if (this.#onEvent) {
      const failed = () => {
        this.#counts.errors++;
        if (this.#phase === "ready" || !this.#errorCode) this.#errorCode = "CARD_CONSUMER_NOTIFY_FAILED";
      };
      try {
        const returned = this.#onEvent();
        if (returned && typeof returned.then === "function") Promise.resolve(returned).catch(failed);
      } catch {
        failed();
      }
    }
  }
  #receive(line) {
    this.#counts.received++;
    let event;
    try {
      event = JSON.parse(decoder.decode(line));
    } catch {
      this.#fatal("CARD_CONSUMER_INVALID_JSON");
      return;
    }
    const row = normalize(event, this.#config, this.#owners);
    if (!row) {
      this.#counts.dropped++;
      return;
    }
    if (this.#phase === "ready") this.#save(row);
    else if (this.#phase === "starting") {
      if (this.#early.length >= 100) {
        this.#fatal("CARD_CONSUMER_PRE_READY_LIMIT");
        return;
      }
      this.#early.push(row);
    } else this.#counts.dropped++;
  }
  #stdout(chunk) {
    if (!["starting", "ready"].includes(this.#phase)) return;
    this.#output = Buffer.concat([this.#output, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (["starting", "ready"].includes(this.#phase)) {
      const newline = this.#output.indexOf(10);
      if ((newline < 0 && this.#output.length > MAX_LINE_BYTES) || newline > MAX_LINE_BYTES) {
        this.#fatal("CARD_CONSUMER_LINE_TOO_LARGE");
        return;
      }
      if (newline < 0) return;
      const line = this.#output.subarray(0, newline);
      this.#output = this.#output.subarray(newline + 1);
      if (line.length) this.#receive(line);
    }
  }
  #diagnosticLine(line) {
    if (/^\[event\] ready event_key=card\.action\.trigger(?:\s|$)/.test(line) && this.#phase === "starting") {
      this.#phase = "ready";
      this.#ready = true;
      clearTimeout(this.#readyTimer);
      const early = this.#early;
      this.#early = [];
      for (const row of early) {
        if (this.#phase !== "ready") {
          this.#counts.dropped++;
          continue;
        }
        this.#save(row);
      }
      if (this.#phase === "ready") this.#settleStart();
      return;
    }
    let body;
    try {
      body = JSON.parse(line);
    } catch {
      return;
    }
    if (body?.ok !== false || !object(body.error)) return;
    const type = body.error.type,
      subtype = body.error.subtype;
    const code =
      subtype === "missing_scope"
        ? "CARD_CONSUMER_SCOPE_REQUIRED"
        : ["authorization", "authentication"].includes(type)
          ? "CARD_CONSUMER_AUTHORIZATION_REQUIRED"
          : type === "validation"
            ? "CARD_CONSUMER_VALIDATION_FAILED"
            : "CARD_CONSUMER_REPORTED_ERROR";
    this.#fatal(code);
  }
  #stderr(chunk) {
    if (!["starting", "ready"].includes(this.#phase)) return;
    this.#diagnostics = Buffer.concat([this.#diagnostics, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (["starting", "ready"].includes(this.#phase)) {
      const newline = this.#diagnostics.indexOf(10);
      if ((newline < 0 && this.#diagnostics.length > MAX_DIAGNOSTIC_BYTES) || newline > MAX_DIAGNOSTIC_BYTES) {
        this.#fatal("CARD_CONSUMER_DIAGNOSTIC_TOO_LARGE");
        return;
      }
      if (newline < 0) return;
      const line = this.#diagnostics.subarray(0, newline).toString("utf8");
      this.#diagnostics = this.#diagnostics.subarray(newline + 1);
      this.#diagnosticLine(line);
    }
  }
  start() {
    if (["closed", "stopping"].includes(this.#phase))
      return Promise.reject(fail("CARD_CONSUMER_NEW_INSTANCE_REQUIRED"));
    if (this.#startPromise) return this.#startPromise;
    if (this.#phase !== "idle") return Promise.reject(fail("CARD_CONSUMER_NEW_INSTANCE_REQUIRED"));
    this.#phase = "starting";
    this.#startPromise = new Promise((resolve, reject) => {
      this.#resolveStart = resolve;
      this.#rejectStart = reject;
    });
    try {
      this.#prepareQueue();
      this.#readyTimer = setTimeout(() => this.#fatal("CARD_CONSUMER_READY_TIMEOUT"), this.#readyTimeout);
      this.#child = this.#spawn(
        this.#config.larkCommand,
        ["--profile", this.#config.profile, "event", "consume", "card.action.trigger", "--as", "bot"],
        {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
        },
      );
      if (
        !this.#child?.stdout?.on ||
        !this.#child?.stderr?.on ||
        !this.#child?.stdin?.on ||
        typeof this.#child.kill !== "function" ||
        typeof this.#child.once !== "function"
      )
        throw fail("CARD_CONSUMER_INVALID_CHILD");
      this.#child.stdin.on("error", () => {
        if (!this.#requestedStop) this.#fatal("CARD_CONSUMER_STDIN_FAILED");
      });
      this.#child.stdout.on("data", (chunk) => this.#stdout(chunk));
      this.#child.stderr.on("data", (chunk) => this.#stderr(chunk));
      this.#child.stdout.on("error", () => this.#fatal("CARD_CONSUMER_OUTPUT_FAILED"));
      this.#child.stderr.on("error", () => this.#fatal("CARD_CONSUMER_DIAGNOSTIC_FAILED"));
      this.#child.once("error", () => this.#fatal("CARD_CONSUMER_SPAWN_FAILED"));
      this.#child.once("close", (code, signal) => this.#finishExit(code, signal));
      // The stdin pipe stays open; unbounded event consumers treat EOF as graceful shutdown.
    } catch (error) {
      const code =
        typeof error?.code === "string" && /^CARD_[A-Z_]+$/.test(error.code)
          ? error.code
          : "CARD_CONSUMER_START_FAILED";
      this.#fatal(code);
    }
    return this.#startPromise;
  }
  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#phase === "idle") {
      this.#requestedStop = true;
      this.#finishExit(0, null);
      return Promise.resolve(this.status());
    }
    if (this.#phase === "closed") return Promise.resolve(this.status());
    this.#requestedStop = true;
    this.#phase = "stopping";
    this.#ready = false;
    this.#settleStart("CARD_CONSUMER_STOPPED");
    this.#terminateOwnChild();
    this.#stopPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#errorCode = "CARD_CONSUMER_STOP_UNCONFIRMED";
        this.#counts.errors++;
        this.#closeQueue();
        reject(fail("CARD_CONSUMER_STOP_UNCONFIRMED"));
      }, this.#stopTimeout);
      this.#closed.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    return this.#stopPromise;
  }
}
