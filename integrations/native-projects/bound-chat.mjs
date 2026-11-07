// This transport only queues a human-readable handoff. It never claims ownership of a desktop session.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedCodexRpc } from "./managed-rpc.mjs";

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const digest = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");
// Stable public-message identity shared with read-only observers; this does not queue anything.
export function boundChatClientId(projectKey, requestId) {
  const hash = digest(["personal-loop-main-chat/v1", projectKey, requestId]);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "5" + hash.slice(13, 16),
    "8" + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join("-");
}
const problem = (code) => Object.assign(new Error(code), { code });
function binding(config, projectKey) {
  const managed = config?.managedCodex,
    b = managed?.boundChats?.[projectKey];
  if (
    managed?.enabled !== true ||
    !b ||
    !uuid.test(b.threadId) ||
    typeof b.projectId !== "string" ||
    !b.projectId ||
    projectKey !== "codex:local:" + encodeURIComponent(b.projectId) ||
    !path.isAbsolute(b.root) ||
    path.resolve(b.root) !== b.root ||
    managed.projectRoots?.[projectKey] !== b.root
  )
    throw problem("BOUND_SCOPE_MISMATCH");
  return { projectId: b.projectId, threadId: b.threadId, root: b.root };
}
function matchThread(t, b) {
  return (
    t?.id === b.threadId &&
    t.cwd === b.root &&
    (t.projectId === null || t.projectId === b.projectId) &&
    t.ephemeral !== true &&
    t.archived !== true
  );
}
async function pages(client, method, params, match, maxPages) {
  let cursor;
  const seen = new Set();
  for (let i = 0; i < maxPages; i++) {
    const page = await client.request(method, { ...params, ...(cursor && { cursor }) });
    if (!Array.isArray(page?.data)) throw problem("BOUND_INVALID_RESPONSE");
    for (const row of page.data) {
      const found = match(row);
      if (found) return found;
    }
    cursor = page.nextCursor;
    if (cursor == null || cursor === "") return null;
    if (typeof cursor !== "string" || seen.has(cursor) || !page.data.length) throw problem("BOUND_INVALID_RESPONSE");
    seen.add(cursor);
  }
  throw problem("BOUND_SCAN_INCOMPLETE");
}
async function verify(client, b) {
  const { project } = await client.request("project/read", { projectId: b.projectId });
  if (project?.id !== b.projectId || !project.roots?.some((r) => r.path === b.root))
    throw problem("BOUND_SCOPE_MISMATCH");
  // thread/read lacks an archive flag on some native versions. Restrict the listing to the bound root.
  // Omit the project filter here so an explicitly bound, previously unassigned chat can match its exact cwd.
  const listed = await pages(
    client,
    "thread/list",
    { cwd: [b.root], archived: false, useStateDbOnly: true, limit: 100 },
    (row) => {
      if (row?.id !== b.threadId) return null;
      if (!matchThread(row, b)) throw problem("BOUND_SCOPE_MISMATCH");
      return row;
    },
    8,
  );
  if (!listed) throw problem("BOUND_NOT_LISTED");
  const { thread } = await client.request("thread/read", { threadId: b.threadId, includeTurns: false });
  if (!matchThread(thread, b) || thread.projectId !== listed.projectId) throw problem("BOUND_SCOPE_MISMATCH");
}
function exactText(inputs, text) {
  return Array.isArray(inputs) && inputs.length === 1 && inputs[0]?.type === "text" && inputs[0].text === text;
}
function turnResult(turn, id, text) {
  if (!Array.isArray(turn?.items) || typeof turn.id !== "string") throw problem("BOUND_INVALID_RESPONSE");
  const matches = turn.items.filter((i) => i?.type === "userMessage" && i.clientId === id);
  if (!matches.length) return null;
  if (matches.length !== 1 || !exactText(matches[0].content, text)) throw problem("BOUND_MESSAGE_CONFLICT");
  const result = { turnId: turn.id, status: "in-thread" };
  if (turn.status === "failed" || turn.status === "interrupted") return { ...result, status: turn.status };
  if (turn.status !== "completed") return result;
  // Multiple user inputs in one turn can steer one another. Do not attribute that turn's answer to a single handoff.
  if (turn.items.filter((i) => i?.type === "userMessage").length !== 1)
    return { ...result, code: "BOUND_AMBIGUOUS_TURN" };
  const after = turn.items.slice(turn.items.indexOf(matches[0]) + 1);
  const finals = after.filter(
    (i) => i?.type === "agentMessage" && i.phase === "final_answer" && typeof i.text === "string" && i.text.trim(),
  );
  if (finals.length !== 1) return { ...result, code: "BOUND_FINAL_UNCONFIRMED" };
  return { ...result, status: "completed", reply: finals[0].text };
}
function journal(config, root, readOnly) {
  const dir = config.managedCodex.stateDir;
  if (!path.isAbsolute(dir) || path.resolve(dir) !== dir || dir === root || dir.startsWith(root + path.sep))
    throw problem("BOUND_PRIVATE_STATE_REQUIRED");
  if (readOnly && !existsSync(dir)) return null;
  if (!readOnly) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const meta = lstatSync(dir);
  if (!meta.isDirectory() || meta.isSymbolicLink() || (meta.mode & 0o077) !== 0 || meta.uid !== process.getuid())
    throw problem("BOUND_PRIVATE_STATE_REQUIRED");
  const file = path.join(dir, "bound-chat.db");
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()))
    throw problem("BOUND_PRIVATE_STATE_REQUIRED");
  if (readOnly && !existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly });
  try {
    if (readOnly) {
      db.exec("PRAGMA query_only=ON");
      return db;
    }
    chmodSync(file, 0o600);
    db.exec(
      "PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)",
    );
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
async function perform(op, args) {
  let client,
    db,
    ids = {};
  try {
    const { config, projectKey, requestId, text, beforeMutation } = args;
    const b = binding(config, projectKey);
    ids = { threadId: b.threadId };
    client =
      args.client ??
      new ManagedCodexRpc({ command: config.managedCodex.command, timeoutMs: config.managedCodex.timeoutMs });
    await client.connect?.();
    await verify(client, b);
    if (op === "verify") return { ...ids, status: "verified" };
    if (
      typeof requestId !== "string" ||
      !requestId.trim() ||
      requestId.length > 512 ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 32000 ||
      (op === "queue" && typeof beforeMutation !== "function")
    )
      throw problem("BOUND_INVALID_HANDOFF");
    const fingerprint = digest([b, text]);
    const id = boundChatClientId(projectKey, requestId);
    ids.clientUserMessageId = id;
    db = journal(config, b.root, op === "inspect");
    const prior = db?.prepare("SELECT fingerprint FROM intents WHERE id=?").get(id);
    if (prior && prior.fingerprint !== fingerprint) throw problem("BOUND_MESSAGE_CONFLICT");
    const queued = () =>
      pages(
        client,
        "thread/queue/list",
        { threadId: b.threadId, limit: 100 },
        (row) => {
          if (row?.clientUserMessageId !== id) return null;
          if (typeof row.id !== "string" || !row.id || !exactText(row.input, text))
            throw problem("BOUND_MESSAGE_CONFLICT");
          return { status: "queued", queuedSubmissionId: row.id };
        },
        5,
      );
    const delivered = () =>
      pages(
        client,
        "thread/turns/list",
        { threadId: b.threadId, limit: 4, sortDirection: "desc", itemsView: "full" },
        (row) => turnResult(row, id, text),
        8,
      );
    const observe = async () => {
      const result = (await queued()) ?? (await delivered());
      await verify(client, b);
      return { ...ids, ...(result ?? { status: "unknown", code: "BOUND_HANDOFF_NOT_OBSERVED" }) };
    };
    if (prior || op === "inspect") return await observe();
    // No earlier intent exists for this never-reused request ID. Recheck the native queue before reserving it.
    const existing = await queued();
    await verify(client, b);
    // The caller must supply a synchronous latest goal + binding guard immediately before the native write.
    const guarded = beforeMutation();
    if (guarded?.then || guarded === false) throw problem("BOUND_GUARD_REQUIRED");
    const reserved = db.prepare("INSERT OR IGNORE INTO intents VALUES(?,?)").run(id, fingerprint);
    if (reserved.changes !== 1) {
      if (db.prepare("SELECT fingerprint FROM intents WHERE id=?").get(id)?.fingerprint !== fingerprint)
        throw problem("BOUND_MESSAGE_CONFLICT");
      return await observe();
    }
    if (existing) return { ...ids, ...existing };
    try {
      const { queuedSubmission } = await client.request("thread/queue/add", {
        threadId: b.threadId,
        clientUserMessageId: id,
        input: [{ type: "text", text }],
      });
      if (queuedSubmission?.clientUserMessageId !== id || !exactText(queuedSubmission.input, text))
        throw problem("BOUND_MESSAGE_CONFLICT");
    } catch (e) {
      if (e.code === "BOUND_MESSAGE_CONFLICT") throw e;
    } // An acknowledgement can be lost after commit.
    return await observe();
  } catch (e) {
    return {
      ...ids,
      status: e.code === "BOUND_NOT_LISTED" ? "missing" : "unknown",
      code: typeof e.code === "string" && e.code.startsWith("BOUND_") ? e.code : "BOUND_UNVERIFIED",
    };
  } finally {
    db?.close();
    if (client && !args.client) await client.close().catch(() => {});
  }
}
export const verifyBoundChat = (args) => perform("verify", args);
export const inspectBoundChat = (args) => perform("inspect", args);
export const queueBoundChat = (args) => perform("queue", args);
