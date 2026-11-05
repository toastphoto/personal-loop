import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync, openSync, closeSync, fstatSync, statSync, readSync } from "node:fs";
import path from "node:path";

const fail = (code) => Object.assign(new Error(code), { code });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
const decoder = new TextDecoder("utf-8", { fatal: true });
const identity = (value) => `${value.dev}:${value.ino}`;

function readBytes(fd, position, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, position + offset);
    if (!count) throw fail("RELAY_QUEUE_CHANGED");
    offset += count;
  }
  return bytes;
}
function anchor(fd, offset) {
  const start = Math.max(0, offset - 256);
  return { start, hash: digest(readBytes(fd, start, offset - start)) };
}
function json(value, code) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw fail(code);
  return encoded;
}
function errorCode(value, fallback) {
  const code = typeof value === "string" ? value : value?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_:-]{0,79}$/.test(code) ? code : fallback;
}

// Exclusive SQLite ownership lasts until close and is released by the OS after a crash.
// It prevents two consumers from applying the same pending command concurrently.
export class RelayQueue {
  constructor(file, { now = Date.now, maxReadBytes = 4 * 1024 * 1024, maxLineBytes = 1024 * 1024 } = {}) {
    if (
      !Number.isSafeInteger(maxReadBytes) ||
      maxReadBytes < 1 ||
      maxReadBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(maxLineBytes) ||
      maxLineBytes < 1 ||
      maxLineBytes > maxReadBytes
    )
      throw fail("INVALID_QUEUE_LIMIT");
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    this.now = now;
    this.maxReadBytes = maxReadBytes;
    this.maxLineBytes = maxLineBytes;
    this.closed = false;
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    try {
      this.db.exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS relay_sources(
          path TEXT PRIMARY KEY, device TEXT NOT NULL, inode TEXT NOT NULL, offset INTEGER NOT NULL,
          anchor_start INTEGER NOT NULL, anchor_hash TEXT NOT NULL, discard_line INTEGER NOT NULL,
          last_size INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relay_messages(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, sender TEXT NOT NULL,
          chat TEXT NOT NULL, identity_hash TEXT NOT NULL, event_json TEXT NOT NULL,
          request_id TEXT NOT NULL, delivery_key TEXT NOT NULL, state TEXT NOT NULL,
          result_json TEXT, response_json TEXT, delivery_ref TEXT,
          handling_attempts INTEGER NOT NULL DEFAULT 0, reply_attempts INTEGER NOT NULL DEFAULT 0,
          handling_error TEXT, reply_error TEXT, handling_retry_at INTEGER NOT NULL DEFAULT 0,
          reply_retry_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        COMMIT;`);
    } catch (error) {
      try {
        this.db.close();
      } catch {}
      this.closed = true;
      if (error.errcode === 5 || error.errcode === 6 || /locked|busy/i.test(error.message))
        throw fail("RELAY_QUEUE_BUSY");
      throw error;
    }
  }
  ensureOpen() {
    if (this.closed) throw fail("RELAY_QUEUE_CLOSED");
  }
  transaction(run) {
    this.ensureOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  source(queuePath) {
    this.ensureOpen();
    return this.db.prepare("SELECT * FROM relay_sources WHERE path=?").get(path.resolve(queuePath)) ?? null;
  }
  cursor(queuePath) {
    const row = this.source(queuePath);
    return row
      ? {
          path: row.path,
          device: row.device,
          inode: row.inode,
          offset: row.offset,
          discardUntilNewline: row.discard_line === 1,
          lastSize: row.last_size,
        }
      : null;
  }
  ingest(queuePath, { initialOffset, filter } = {}) {
    this.ensureOpen();
    if (typeof filter !== "function") throw fail("RELAY_FILTER_REQUIRED");
    const absolute = path.resolve(queuePath);
    const prior = this.source(absolute);
    if (!prior && initialOffset !== "tail" && initialOffset !== 0) throw fail("INITIAL_OFFSET_REQUIRED");
    let fd;
    try {
      fd = openSync(absolute, "r");
    } catch {
      throw fail("RELAY_QUEUE_UNAVAILABLE");
    }
    try {
      const file = fstatSync(fd, { bigint: true });
      if (!file.isFile() || file.size > BigInt(Number.MAX_SAFE_INTEGER)) throw fail("INVALID_QUEUE_FILE");
      const size = Number(file.size);
      const offset = prior ? prior.offset : initialOffset === "tail" ? size : 0;
      let discard = prior
        ? prior.discard_line === 1
        : initialOffset === "tail" && size > 0 && readBytes(fd, size - 1, 1)[0] !== 10;
      if (prior) {
        if (`${prior.device}:${prior.inode}` !== identity(file) || size < offset) throw fail("RELAY_QUEUE_CHANGED");
        if (digest(readBytes(fd, prior.anchor_start, offset - prior.anchor_start)) !== prior.anchor_hash)
          throw fail("RELAY_QUEUE_CHANGED");
      }
      const bytes = readBytes(fd, offset, Math.min(size - offset, this.maxReadBytes));
      const end = bytes.lastIndexOf(10) + 1;
      if (end === 0 && bytes.length > this.maxLineBytes) throw fail("RELAY_LINE_TOO_LARGE");
      const events = [];
      let skipped = 0,
        position = 0;
      while (position < end) {
        const newline = bytes.indexOf(10, position);
        const length = newline - position;
        if (length > this.maxLineBytes) throw fail("RELAY_LINE_TOO_LARGE");
        const raw = bytes.subarray(position, newline);
        position = newline + 1;
        if (discard) {
          discard = false;
          skipped++;
          continue;
        }
        let line;
        try {
          line = decoder.decode(raw).trim();
        } catch {
          throw fail("RELAY_INVALID_UTF8");
        }
        if (!line) {
          skipped++;
          continue;
        }
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          throw fail("RELAY_INVALID_NDJSON");
        }
        const selected = filter(event);
        if (selected && typeof selected.then === "function") throw fail("FILTER_MUST_BE_SYNCHRONOUS");
        if (!selected) {
          skipped++;
          continue;
        }
        if (
          !event ||
          typeof event !== "object" ||
          Array.isArray(event) ||
          !text(event.message_id) ||
          !text(event.sender_id) ||
          !text(event.chat_id)
        )
          throw fail("INVALID_RELAY_EVENT");
        const semanticIdentity = digest(
          json(
            [event.message_id, event.sender_id, event.chat_id, event.message_type ?? null, event.content ?? null],
            "INVALID_RELAY_EVENT",
          ),
        );
        events.push({ event, semanticIdentity });
      }
      const nextOffset = offset + end;
      // Rotation can happen while the pure filter runs; never checkpoint replacement bytes we did not parse.
      if (!readBytes(fd, offset, end).equals(bytes.subarray(0, end))) throw fail("RELAY_QUEUE_CHANGED");
      if (prior && digest(readBytes(fd, prior.anchor_start, offset - prior.anchor_start)) !== prior.anchor_hash)
        throw fail("RELAY_QUEUE_CHANGED");
      const nextAnchor = anchor(fd, nextOffset);
      let current;
      try {
        current = statSync(absolute, { bigint: true });
      } catch {
        throw fail("RELAY_QUEUE_CHANGED");
      }
      if (identity(current) !== identity(file) || current.size < BigInt(nextOffset)) throw fail("RELAY_QUEUE_CHANGED");
      return this.transaction(() => {
        let inserted = 0,
          duplicates = 0;
        for (const { event, semanticIdentity } of events) {
          const existing = this.db.prepare("SELECT * FROM relay_messages WHERE id=?").get(event.message_id);
          if (existing) {
            if (existing.identity_hash !== semanticIdentity) throw fail("MESSAGE_ID_CONFLICT");
            duplicates++;
            continue;
          }
          const key = digest(event.message_id);
          this.db
            .prepare(
              `INSERT INTO relay_messages
            (id,sender,chat,identity_hash,event_json,request_id,delivery_key,state,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              event.message_id,
              event.sender_id,
              event.chat_id,
              semanticIdentity,
              json(event, "INVALID_RELAY_EVENT"),
              `relay:${key}`,
              `plr-${key.slice(0, 40)}`,
              "pending",
              this.now(),
            );
          inserted++;
        }
        this.db
          .prepare(
            `INSERT INTO relay_sources VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(path) DO UPDATE SET device=excluded.device,inode=excluded.inode,offset=excluded.offset,
          anchor_start=excluded.anchor_start,anchor_hash=excluded.anchor_hash,discard_line=excluded.discard_line,
          last_size=excluded.last_size,updated_at=excluded.updated_at`,
          )
          .run(
            absolute,
            String(file.dev),
            String(file.ino),
            nextOffset,
            nextAnchor.start,
            nextAnchor.hash,
            discard ? 1 : 0,
            size,
            this.now(),
          );
        return {
          inserted,
          duplicates,
          skipped,
          offset: nextOffset,
          pendingBytes: size - nextOffset,
          initializedAtTail: !prior && initialOffset === "tail",
        };
      });
    } finally {
      closeSync(fd);
    }
  }
  decode(row) {
    return row
      ? {
          id: row.id,
          requestId: row.request_id,
          event: JSON.parse(row.event_json),
          state: row.state,
          result: row.result_json === null ? null : JSON.parse(row.result_json),
          response: row.response_json === null ? null : JSON.parse(row.response_json),
          deliveryKey: row.delivery_key,
          deliveryRef: row.delivery_ref,
          handlingAttempts: row.handling_attempts,
          replyAttempts: row.reply_attempts,
          handlingError: row.handling_error,
          replyError: row.reply_error,
          handlingRetryAt: row.handling_retry_at,
          replyRetryAt: row.reply_retry_at,
          createdAt: row.created_at,
        }
      : null;
  }
  get(id) {
    this.ensureOpen();
    return this.decode(this.db.prepare("SELECT * FROM relay_messages WHERE id=?").get(id));
  }
  pending({ limit = 50 } = {}) {
    this.ensureOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail("INVALID_QUEUE_LIMIT");
    return this.db
      .prepare("SELECT * FROM relay_messages WHERE state='pending' AND handling_retry_at<=? ORDER BY seq LIMIT ?")
      .all(this.now(), limit)
      .map((row) => this.decode(row));
  }
  saveResult(id, result, response) {
    const encodedResult = json(result, "INVALID_RELAY_RESULT");
    const encodedResponse = json(response, "INVALID_RELAY_RESPONSE");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM relay_messages WHERE id=?").get(id);
      if (!row) throw fail("RELAY_MESSAGE_NOT_FOUND");
      if (row.state !== "pending") {
        if (row.result_json !== encodedResult || row.response_json !== encodedResponse)
          throw fail("RESULT_ALREADY_SAVED");
        return this.decode(row);
      }
      this.db
        .prepare(
          "UPDATE relay_messages SET state='handled',result_json=?,response_json=?,handling_error=NULL WHERE id=?",
        )
        .run(encodedResult, encodedResponse, id);
      return this.get(id);
    });
  }
  pendingReplies({ limit = 50 } = {}) {
    this.ensureOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail("INVALID_QUEUE_LIMIT");
    return this.db
      .prepare("SELECT * FROM relay_messages WHERE state='handled' AND reply_retry_at<=? ORDER BY seq LIMIT ?")
      .all(this.now(), limit)
      .map((row) => this.decode(row));
  }
  markReply(id, deliveryRef) {
    if (!text(deliveryRef)) throw fail("INVALID_DELIVERY_REF");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM relay_messages WHERE id=?").get(id);
      if (!row) throw fail("RELAY_MESSAGE_NOT_FOUND");
      if (row.state === "pending") throw fail("RESULT_NOT_SAVED");
      if (row.state === "replied") {
        if (row.delivery_ref !== deliveryRef) throw fail("DELIVERY_REF_CONFLICT");
        return this.decode(row);
      }
      if (row.state !== "handled") throw fail("REPLY_NOT_PENDING");
      this.db
        .prepare("UPDATE relay_messages SET state='replied',delivery_ref=?,reply_error=NULL WHERE id=?")
        .run(deliveryRef, id);
      return this.get(id);
    });
  }
  // Exhausted delivery stays observable without occupying the retry window forever.
  markReplyAbandoned(id, error) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM relay_messages WHERE id=?").get(id);
      if (!row) throw fail("RELAY_MESSAGE_NOT_FOUND");
      if (row.state === "reply_failed") return this.decode(row);
      if (row.state === "pending") throw fail("RESULT_NOT_SAVED");
      if (row.state === "replied") throw fail("ALREADY_REPLIED");
      if (row.state !== "handled") throw fail("REPLY_NOT_PENDING");
      this.db
        .prepare("UPDATE relay_messages SET state='reply_failed',reply_error=? WHERE id=?")
        .run(errorCode(error, "RELAY_REPLY_ABANDONED"), id);
      return this.get(id);
    });
  }
  // Revocation discards unsent work, not the historical fact that a reply was delivered.
  discard(id, error) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM relay_messages WHERE id=?").get(id);
      if (!row) throw fail("RELAY_MESSAGE_NOT_FOUND");
      if (row.state === "ignored") return this.decode(row);
      if (row.state === "replied") throw fail("ALREADY_REPLIED");
      const code = errorCode(error, "RELAY_DISCARDED");
      this.db
        .prepare(
          `UPDATE relay_messages SET state='ignored',
          handling_error=CASE WHEN state='pending' THEN ? ELSE handling_error END,
          reply_error=CASE WHEN state IN ('handled','reply_failed') THEN ? ELSE reply_error END WHERE id=?`,
        )
        .run(code, code, id);
      return this.get(id);
    });
  }
  markFailure(id, stage, error, { retryAfterMs = 5000 } = {}) {
    if (
      !["handling", "reply"].includes(stage) ||
      !Number.isSafeInteger(retryAfterMs) ||
      retryAfterMs < 0 ||
      retryAfterMs > 86400000
    )
      throw fail("INVALID_RETRY");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM relay_messages WHERE id=?").get(id);
      if (!row) throw fail("RELAY_MESSAGE_NOT_FOUND");
      if (stage === "handling" && row.state !== "pending") throw fail("RESULT_ALREADY_SAVED");
      if (stage === "reply" && row.state !== "handled")
        throw fail(
          row.state === "pending"
            ? "RESULT_NOT_SAVED"
            : row.state === "replied"
              ? "ALREADY_REPLIED"
              : "REPLY_NOT_PENDING",
        );
      const code = errorCode(error, stage === "handling" ? "RELAY_HANDLER_FAILED" : "RELAY_REPLY_FAILED");
      this.db
        .prepare(
          `UPDATE relay_messages SET ${stage}_attempts=${stage}_attempts+1,${stage}_error=?,${stage}_retry_at=? WHERE id=?`,
        )
        .run(code, this.now() + retryAfterMs, id);
      return this.get(id);
    });
  }
  stats() {
    this.ensureOpen();
    return Object.fromEntries(
      this.db
        .prepare("SELECT state,COUNT(*) AS count FROM relay_messages GROUP BY state")
        .all()
        .map((row) => [row.state, row.count]),
    );
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
