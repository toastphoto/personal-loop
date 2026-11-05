import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { failure, safeError } from "./catalog.mjs";

// An uncertain request stays uncertain. Never retry a possibly accepted mutation as a new task.
export class Operations {
  constructor(file, catalog, grants = [], controls = null) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, hash TEXT NOT NULL, project TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL);",
    );
    this.catalog = catalog;
    this.grants = grants;
    this.controls = controls;
  }
  async run(action, args) {
    if (!["continue", "cancel"].includes(action)) throw failure("UNSUPPORTED_ACTION");
    if (!args || !/^[A-Za-z0-9_.:-]{1,160}$/.test(args.operationId ?? "") || !args.nativeId)
      throw failure("INVALID_OPERATION");
    if (action === "continue" && (typeof args.text !== "string" || !args.text.trim() || args.text.length > 20000))
      throw failure("INVALID_OPERATION");
    const grant = this.grants.find(
      (g) =>
        g.projectKey === args.projectKey &&
        g.actions?.includes(action) &&
        Date.parse(g.expiresAt) > Date.now() &&
        Number.isSafeInteger(g.maxActions) &&
        g.maxActions > 0,
    );
    if (!grant) throw failure("PROJECT_ACTION_NOT_AUTHORIZED");
    const { backend } = this.catalog.resolve(args.projectKey);
    const selection = action === "continue" ? this.controls?.assertActive(args.projectKey) : null;
    if (action === "continue" && !selection) throw failure("LOOP_NOT_ACTIVE");
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          action,
          args.projectKey,
          args.nativeId,
          args.text ?? null,
          args.turnId ?? null,
          args.executionId ?? null,
        ]),
      )
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT * FROM operations WHERE id=?").get(args.operationId);
      if (prior) {
        if (prior.hash !== hash) throw failure("OPERATION_ID_REUSED");
        this.db.exec("COMMIT");
        return prior.result
          ? JSON.parse(prior.result)
          : { operationId: args.operationId, state: "unknown", requiresReconciliation: true };
      }
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE project=?").get(args.projectKey).n;
      if (count >= Math.min(grant.maxActions, selection?.maxSteps ?? grant.maxActions))
        throw failure("ACTION_BUDGET_EXHAUSTED");
      this.db
        .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?)")
        .run(args.operationId, hash, args.projectKey, "dispatching", null, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    let result;
    try {
      await this.catalog.readWork(args.projectKey, args.nativeId);
      if (action === "continue") this.controls.assertActive(args.projectKey, selection.revision);
      const beforeMutation = () => {
        if (action === "continue") this.controls.assertActive(args.projectKey, selection.revision);
        if (Date.parse(grant.expiresAt) <= Date.now()) throw failure("PROJECT_ACTION_NOT_AUTHORIZED");
      };
      const native =
        action === "continue"
          ? await backend.continueWork({ ...args, requestId: args.operationId, beforeMutation })
          : await backend.cancelWork({ ...args, beforeMutation });
      result = {
        operationId: args.operationId,
        state: native?.accepted === true ? "accepted" : native?.accepted === false ? "rejected" : "unknown",
        native,
        completionVerified: false,
        ...(native?.accepted == null ? { requiresReconciliation: true } : {}),
      };
    } catch (error) {
      const code = safeError(error);
      const rejected =
        /NOT_AUTHORIZED|WRITE_DISABLED|NOT_ENABLED|UNSUPPORTED|PROJECT_MISMATCH|NOT_FOUND|BUSY|LOOP_NOT_ACTIVE|CONTROL_REVISION_CHANGED|LOOP_DEADLINE_REACHED/.test(
          code,
        );
      result = {
        operationId: args.operationId,
        state: rejected ? "rejected" : "unknown",
        errorCode: code,
        requiresReconciliation: !rejected,
      };
    }
    this.db
      .prepare("UPDATE operations SET state=?,result=? WHERE id=?")
      .run(result.state, JSON.stringify(result), args.operationId);
    return result;
  }
  close() {
    this.db.close();
  }
}
