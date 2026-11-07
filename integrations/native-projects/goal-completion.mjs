// A planner's finish is provisional until the same hub run has committed it with no remaining work.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { subjectFor } from "./controls.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const actor = "goal-completion";
const inside = (file, root) => file === root || file.startsWith(root + path.sep);

function privateFile(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw Error("Unverified private file");
  const parent = path.dirname(file),
    dir = lstatSync(parent),
    stat = lstatSync(file);
  if (
    realpathSync(parent) !== parent ||
    !dir.isDirectory() ||
    dir.uid !== process.getuid() ||
    dir.mode & 0o077 ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw Error("Unverified private file");
}
function readOnly(file, fn) {
  privateFile(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    return fn(db);
  } finally {
    db.close();
  }
}
function completed(nativeConfig, configFile, control) {
  const managed = nativeConfig.managedCodex,
    key = control.projectKey,
    binding = managed?.boundChats?.[key];
  if (
    managed?.enabled !== true ||
    !managed.coordinatorProjectKeys?.includes(key) ||
    !binding?.threadId ||
    key !== "codex:local:" + encodeURIComponent(binding.projectId) ||
    !path.isAbsolute(binding.root ?? "") ||
    managed.projectRoots?.[key] !== binding.root ||
    !path.isAbsolute(managed.stateDir ?? "") ||
    inside(path.resolve(managed.stateDir), path.resolve(binding.root)) ||
    (control.expectedThreadId && control.expectedThreadId !== binding.threadId) ||
    !control.goalStartEvent ||
    !Number.isSafeInteger(control.goalRevision) ||
    control.goalRevision < 1 ||
    typeof control.objective !== "string" ||
    !control.objective.trim()
  )
    return null;
  const goalId = hash([key, binding.projectId, binding.root, control.objective, control.goalRevision]);
  const workerFile = path.join(managed.stateDir, hash(key), "worker.db");
  const ending = readOnly(workerFile, (db) => {
    if (
      db.prepare("SELECT binding FROM bound_routes WHERE goal_id=?").get(goalId)?.binding !==
      JSON.stringify([binding.threadId, binding.projectId, binding.root])
    )
      return null;
    const row = db
      .prepare("SELECT run_id,state,result FROM requests WHERE goal_id=? ORDER BY rowid DESC LIMIT 1")
      .get(goalId);
    if (row?.state !== "completed") return null;
    const result = JSON.parse(row.result ?? "null"),
      match = /^([1-9][0-9]{0,19})(?::attempt:([2-9]|10))?$/.exec(row.run_id);
    if (
      !match ||
      !Number.isSafeInteger(Number(match[1])) ||
      result?.state !== "completed" ||
      result.coordinator?.action !== "finish" ||
      result.coordinator.runId !== match[1]
    )
      return null;
    return { runId: Number(match[1]), attempt: Number(match[2] ?? 1) };
  });
  if (!ending) return null;
  const hubConfig = nativeConfig.loopHub?.configFile;
  if (typeof hubConfig !== "string" || !path.isAbsolute(hubConfig) || inside(hubConfig, binding.root)) return null;
  const rule = "native-project:" + subjectFor(key),
    agent = "native-managed-" + subjectFor(key);
  const accepted = readOnly(path.join(path.dirname(hubConfig), "hub.db"), (db) => {
    const get = (collection, id) =>
      JSON.parse(
        db.prepare("SELECT data FROM projections WHERE collection=? AND key=?").get(collection, String(id))?.data ??
          "null",
      );
    const run = get("runs", ending.runId);
    if (
      run?.state !== "done" ||
      run.rule !== rule ||
      run.grp !== rule ||
      run.agent !== agent ||
      run.attempts + 1 !== ending.attempt ||
      !run.finished_at ||
      !run.last_result
    )
      return false;
    const frozen = get("config", run.rules_version)?.value,
      owner = frozen?.agents?.[agent];
    if (
      owner?.use !== "native-managed" ||
      owner.command?.[0] !== configFile ||
      owner.command?.[1] !== key ||
      !owner.name?.startsWith(`原生项目 ${subjectFor(key).slice(0, 10)} · 目标 ${control.goalRevision} · 控制 `)
    )
      return false;
    const any = (collection, condition, values = []) =>
      db
        .prepare(
          "SELECT 1 FROM projections WHERE collection=? AND json_extract(data,'$.rule')=? AND " +
            condition +
            " LIMIT 1",
        )
        .get(collection, rule, ...values);
    if (
      any("runs", "json_extract(data,'$.state') IN ('queued','claimed','unknown')") ||
      any("timers", "json_extract(data,'$.event_id') IS NULL") ||
      any("cards", "json_extract(data,'$.kind')='ask' AND json_extract(data,'$.state') IN ('open','decided')")
    )
      return false;
    return !!any(
      "cards",
      "json_extract(data,'$.kind')='notice' AND json_extract(data,'$.run_id')=? AND json_extract(data,'$.key')=?",
      [ending.runId, `thread:${rule}:${run.lane}:goal-complete-${goalId.slice(0, 40)}`],
    );
  });
  return accepted ? { goalId, ...ending } : null;
}

export async function settleCompletedGoals({ nativeConfig, configFile, controls, runtime }) {
  const results = [];
  for (const control of controls.list()) {
    if (
      control.maxSteps !== null ||
      !(control.mode === "active" || (control.mode === "manual" && control.actor === actor))
    )
      continue;
    try {
      privateFile(configFile);
      const fresh = JSON.parse(readFileSync(configFile, "utf8"));
      if (
        JSON.stringify(fresh.managedCodex) !== JSON.stringify(nativeConfig.managedCodex) ||
        JSON.stringify(fresh.loopHub) !== JSON.stringify(nativeConfig.loopHub)
      )
        continue;
      const end = completed(fresh, configFile, control);
      if (!end) continue;
      const requestId = "goal-finish:" + end.goalId;
      const current = controls.get(control.projectKey);
      if (
        current.revision !== control.revision ||
        current.mode !== control.mode ||
        current.goalRevision !== control.goalRevision
      )
        continue;
      const settled =
        control.mode === "manual"
          ? current
          : controls.set(control.projectKey, "manual", {
              actor,
              expectedRevision: control.revision,
              requestId,
            });
      // Do not let an idempotent control result from an earlier generation remove a newer rule.
      if (controls.get(control.projectKey).revision !== settled.revision || settled.mode !== "manual") continue;
      const synced = await runtime.sync({
        projectKey: control.projectKey,
        control: settled,
        action: "manual",
        requestId,
      });
      results.push({
        projectKey: control.projectKey,
        goalRevision: control.goalRevision,
        status: synced?.ok === true ? "completed" : "sync-pending",
      });
    } catch {
      const current = controls.get(control.projectKey);
      if (current.mode === "manual" && current.actor === actor && current.goalRevision === control.goalRevision)
        results.push({ projectKey: control.projectKey, goalRevision: control.goalRevision, status: "sync-pending" });
    }
  }
  return results;
}
