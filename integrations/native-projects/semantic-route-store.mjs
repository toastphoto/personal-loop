// A receipt gives exactly one dispatcher ownership. Only digests and the verdict ever reach disk.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const fail = (code) => Object.assign(new Error(code), { code });
const digest = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const verdict = (v) => v === "loop" || v === "legacy";
export function eligibleSemanticRoute(e, r = {}) {
  const s = r.semanticQueries;
  const when =
    typeof s?.enabledAt === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/u.test(s.enabledAt) ? Date.parse(s.enabledAt) : NaN;
  const created = e?.create_time;
  return Boolean(
    r.enabled === true &&
    s?.enabled === true &&
    typeof s.decisionDir === "string" &&
    path.isAbsolute(s.decisionDir) &&
    e?.message_type === "text" &&
    e.sender_type === "user" &&
    typeof e.chat_id === "string" &&
    e.chat_id === r.chatId &&
    typeof e.sender_id === "string" &&
    Array.isArray(r.allowedSenderIds) &&
    r.allowedSenderIds.includes(e.sender_id) &&
    Array.isArray(e.mentions) &&
    e.mentions.length === 1 &&
    typeof e.mentions[0]?.id === "string" &&
    Array.isArray(r.botMentionIds) &&
    r.botMentionIds.includes(e.mentions[0].id) &&
    typeof e.message_id === "string" &&
    /^om_[A-Za-z0-9_-]{1,160}$/u.test(e.message_id) &&
    typeof e.content === "string" &&
    Boolean(e.content.trim()) &&
    e.content.length <= 6000 &&
    /^\d{13}$/u.test(String(created ?? "")) &&
    Number(created) >= when &&
    Number(created) <= Date.now() + 300_000,
  );
}
function location(e, r) {
  if (!eligibleSemanticRoute(e, r)) throw fail("SEMANTIC_SCOPE_DENIED");
  const dir = r.semanticQueries.decisionDir;
  const stat = lstatSync(dir);
  if (realpathSync(dir) !== dir || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
    throw fail("SEMANTIC_STORE_UNSAFE");
  const key = digest([e.chat_id, e.message_id]);
  const m = e.mentions[0];
  const fingerprint = digest([
    1,
    r.semanticQueries.enabledAt,
    e.chat_id,
    e.message_id,
    e.sender_id,
    String(e.create_time),
    e.content,
    m.id,
    m.name ?? null,
    m.key ?? null,
  ]);
  return { dir, file: path.join(dir, key + ".json"), fingerprint };
}
function stored({ file, fingerprint }) {
  let fd;
  try {
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 1024)
      throw fail("SEMANTIC_STORE_UNSAFE");
    let record;
    try {
      record = JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      throw fail("SEMANTIC_VERDICT_INVALID");
    }
    if (record?.version !== 1 || !verdict(record.owner) || typeof record.fingerprint !== "string")
      throw fail("SEMANTIC_VERDICT_INVALID");
    if (record.fingerprint !== fingerprint) throw fail("SEMANTIC_VERDICT_CONFLICT");
    return record.owner;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function readSemanticRoute(e, r) {
  if (!eligibleSemanticRoute(e, r)) return "loop";
  try {
    return stored(location(e, r)) ?? "pending";
  } catch (error) {
    return error.code === "SEMANTIC_VERDICT_CONFLICT" ? "loop" : "pending";
  }
}
export function finishSemanticRoute(e, r, owner) {
  if (!verdict(owner)) throw fail("SEMANTIC_VERDICT_INVALID");
  const state = location(e, r);
  const check = (known) => {
    if (known !== owner) throw fail("SEMANTIC_VERDICT_CONFLICT");
    return known;
  };
  const known = stored(state);
  if (known !== null) return check(known);
  // Publish a fully fsynced record without replacing another process's verdict.
  const temp = path.join(state.dir, "." + randomUUID() + ".tmp");
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, fingerprint: state.fingerprint, owner }) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, state.file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return check(stored(state));
    }
    const directory = openSync(state.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return owner;
  } finally {
    unlinkSync(temp);
  }
}
