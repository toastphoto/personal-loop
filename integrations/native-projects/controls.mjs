import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { failure } from "./catalog.mjs";

export const subjectFor = (key) => createHash("sha256").update(key).digest("hex");
export class LoopControls {
  constructor(file) {
    this.file = file;
  }
  read() {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (data.version !== 1 || !data.projects || Array.isArray(data.projects)) throw failure("INVALID_CONTROL_STATE");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, projects: {} };
      throw error;
    }
  }
  get(key) {
    return this.read().projects[key] ?? { projectKey: key, mode: "manual", revision: 0, cancelRunning: false };
  }
  list() {
    return Object.values(this.read().projects);
  }
  assertActive(key, revision) {
    const goal = this.get(key);
    if (goal.mode !== "active") throw failure("LOOP_NOT_ACTIVE");
    if (revision != null && goal.revision !== revision) throw failure("CONTROL_REVISION_CHANGED");
    if (goal.deadline && Date.parse(goal.deadline) <= Date.now()) throw failure("LOOP_DEADLINE_REACHED");
    return goal;
  }
  set(
    key,
    mode,
    { actor, expectedRevision, objective, maxSteps, deadline, requestId, projectName, expectedThreadId } = {},
  ) {
    if (!["manual", "active", "paused"].includes(mode) || typeof key !== "string" || !key || !actor)
      throw failure("INVALID_MODE_CHANGE");
    return this.withLock((data) => {
      const budgetIntent =
        maxSteps === undefined
          ? mode === "active" && objective !== undefined
            ? "until-done"
            : "preserve"
          : maxSteps === null
            ? "until-done"
            : maxSteps;
      let requestHash;
      if (requestId !== undefined) {
        if (typeof requestId !== "string" || !/^[A-Za-z0-9_.:-]{1,512}$/.test(requestId))
          throw failure("INVALID_CONTROL_REQUEST");
        requestHash = createHash("sha256")
          .update(
            JSON.stringify([
              key,
              mode,
              actor,
              objective ?? null,
              maxSteps ?? null,
              deadline ?? null,
              ...(expectedThreadId ? [expectedThreadId] : []),
            ]),
          )
          .digest("hex");
        const previous = data.requests?.[requestId];
        if (previous) {
          if (
            previous.hash !== requestHash ||
            (Object.hasOwn(previous, "budgetIntent") && previous.budgetIntent !== budgetIntent)
          )
            throw failure("CONTROL_REQUEST_ID_REUSED");
          return previous.result;
        }
      }
      const old = data.projects[key] ?? { revision: 0 };
      if (expectedRevision != null && old.revision !== expectedRevision) throw failure("CONTROL_REVISION_CHANGED");
      const next = {
        ...old,
        projectKey: key,
        mode,
        actor,
        revision: old.revision + 1,
        updatedAt: new Date().toISOString(),
        cancelRunning: false,
      };
      if (typeof projectName === "string" && projectName.trim()) next.projectName = projectName.slice(0, 500);
      if (objective !== undefined) {
        next.objective = objective;
        if (expectedThreadId) next.expectedThreadId = expectedThreadId;
        else delete next.expectedThreadId;
        if (mode === "active") next.goalRevision = next.revision;
      }
      if (mode === "active" && requestId !== undefined) {
        next.goalControlEvent =
          "native-control-" +
          createHash("sha256")
            .update(JSON.stringify([key, requestId]))
            .digest("hex");
        if (objective !== undefined) next.goalStartEvent = next.goalControlEvent;
      }
      if (maxSteps !== undefined) next.maxSteps = maxSteps;
      else if (mode === "active" && objective !== undefined) next.maxSteps = null;
      if (deadline !== undefined) next.deadline = deadline;
      if (mode === "active") {
        if (typeof next.objective !== "string" || !next.objective.trim()) throw failure("OBJECTIVE_REQUIRED");
        if (
          next.maxSteps !== null &&
          (!Number.isSafeInteger(next.maxSteps) || next.maxSteps < 1 || next.maxSteps > 100)
        )
          throw failure("INVALID_STEP_BUDGET");
        if (next.deadline && (!Number.isFinite(Date.parse(next.deadline)) || Date.parse(next.deadline) <= Date.now()))
          throw failure("INVALID_DEADLINE");
      }
      data.projects[key] = next;
      if (requestId !== undefined) {
        data.requests ??= {};
        data.requests[requestId] = { hash: requestHash, result: next, budgetIntent };
      }
      this.save(data);
      return next;
    });
  }
  save(data) {
    writeFileSync(this.file + ".tmp", JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  withLock(fn) {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = new DatabaseSync(this.file + ".lock.db");
      chmodSync(this.file + ".lock.db", 0o600);
      lock.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS guard(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;");
    } catch (error) {
      try {
        lock?.close();
      } catch {}
      if (error.errcode === 5 || error.errcode === 6) throw failure("CONTROL_UPDATE_BUSY");
      throw error;
    }
    try {
      return fn(this.read());
    } finally {
      if (lock.isTransaction) lock.exec("ROLLBACK");
      lock.close();
    }
  }
}

export function ownedRules(goals, { source, agent, cwd }) {
  return goals
    .filter((g) => g.mode === "active" && (!g.deadline || Date.parse(g.deadline) > Date.now()))
    .map((g) => ({
      name: `native-project:${subjectFor(g.projectKey)}`,
      when: { source, types: [`native.project.${subjectFor(g.projectKey).slice(0, 32)}.changed`] },
      to: agent,
      cwd,
      group: `native-project:${subjectFor(g.projectKey)}`,
      tell: "needed",
      prompt: `先读取可信的项目推进规则与最新控制状态。目标项目标识：${g.projectKey}。控制版本：${g.revision}。只有仍启用且未超过预算时才能推进；已暂停则保存状态并结束，不再预约。目标与验收要求从可信配置读取。`,
    }));
}
