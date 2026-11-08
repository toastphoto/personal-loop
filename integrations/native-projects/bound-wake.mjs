// A verified queued handoff may wake its existing desktop conversation once, without adding another message.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectBoundChat } from "./bound-chat.mjs";

export async function wakeQueuedBoundChat(
  { config, projectKey, requestId, text, beforeMutation },
  { inspect = inspectBoundChat, launch, platform = process.platform, exists = existsSync } = {},
) {
  const managed = config?.managedCodex;
  if (platform !== "darwin" || !managed?.wakeBoundProjectKeys?.includes(projectKey)) return { status: "disabled" };
  const app = /^(\/Applications\/[^/]+\.app)\/Contents\//u.exec(managed.command ?? "")?.[1];
  if (!app || !exists(app) || typeof beforeMutation !== "function") return { status: "unavailable" };
  const observed = await inspect({ config, projectKey, requestId, text });
  if (observed.status !== "queued") return { status: "not-queued" };
  const binding = managed.boundChats?.[projectKey];
  if (!binding || observed.threadId !== binding.threadId || !/^[a-f0-9-]{36}$/i.test(binding.threadId))
    return { status: "unverified" };
  // inspectBoundChat has already checked the private journal, exact input, current binding and original queue.
  const file = path.join(managed.stateDir, "bound-chat.db");
  if (!exists(file)) return { status: "unverified" };
  const meta = lstatSync(file),
    dir = lstatSync(managed.stateDir);
  if (
    !meta.isFile() ||
    meta.isSymbolicLink() ||
    meta.uid !== process.getuid() ||
    meta.mode & 0o077 ||
    !dir.isDirectory() ||
    dir.uid !== process.getuid() ||
    dir.mode & 0o077 ||
    realpathSync(managed.stateDir) !== managed.stateDir
  )
    return { status: "unverified" };
  const db = new DatabaseSync(file);
  const id = createHash("sha256")
    .update(JSON.stringify([projectKey, requestId, binding.threadId]))
    .digest("hex");
  try {
    db.exec(
      "PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS desktop_wakes(id TEXT PRIMARY KEY,status TEXT NOT NULL); BEGIN IMMEDIATE",
    );
    const previous = db.prepare("SELECT status FROM desktop_wakes WHERE id=?").get(id);
    if (previous) {
      db.exec("COMMIT");
      return { status: previous.status, replayed: true };
    }
    const guarded = beforeMutation();
    if (guarded === false || guarded?.then) throw Error("BOUND_WAKE_GUARD_REQUIRED");
    db.prepare("INSERT INTO desktop_wakes VALUES(?,?)").run(id, "attempted");
    db.exec("COMMIT");
    const run =
      launch ??
      ((args) =>
        new Promise((resolve) => execFile("/usr/bin/open", args, { timeout: 10000 }, (error) => resolve(!error))));
    const ok = await run(["-g", "-a", app, `codex://threads/${binding.threadId}`]);
    const status = ok ? "wake-requested" : "unavailable";
    db.prepare("UPDATE desktop_wakes SET status=? WHERE id=?").run(status, id);
    return { status };
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}
