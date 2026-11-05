import { execFile } from "node:child_process";

const ACTIVE = new Set(["queued", "pending", "claimed", "preparing", "running", "cancelling"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function id(value, label = "id") {
  if (typeof value !== "string" || !identifier.test(value)) {
    throw failure("MULTICA_INVALID_ARGUMENT", `Invalid ${label}`);
  }
  return value;
}

function beforeWrite(callback) {
  if (callback === undefined) return;
  if (typeof callback !== "function")
    throw failure("MULTICA_INVALID_ARGUMENT", "beforeMutation must be a synchronous function");
  const result = callback();
  if (result && typeof result.then === "function") {
    Promise.resolve(result).catch(() => {});
    throw failure("MULTICA_INVALID_ARGUMENT", "beforeMutation must not return a promise");
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function nativeCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const { input, ...processOptions } = options;
    const child = execFile(command, args, processOptions, (error, stdout, stderr) => {
      if (error) {
        if (error.code === "ENOENT") reject(failure("MULTICA_UNAVAILABLE", "Multica executable is unavailable"));
        else if (error.killed || error.name === "AbortError")
          reject(failure("MULTICA_TIMEOUT", "Multica command timed out"));
        else resolve({ stdout, stderr, exitCode: typeof error.code === "number" ? error.code : 1 });
      } else resolve({ stdout, stderr, exitCode: 0 });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** Project and Issue metadata stay in Multica; this connector never stores credentials or invokes a shell. */
export class MulticaConnector {
  constructor(options = {}) {
    this.command = options.command ?? "multica";
    if (typeof this.command !== "string" || !this.command.trim() || this.command.includes("\0")) {
      throw failure("MULTICA_INVALID_ARGUMENT", "Invalid Multica executable");
    }
    this.profile = options.profile === undefined ? undefined : id(options.profile, "profile");
    this.workspaceId = options.workspaceId === undefined ? undefined : id(options.workspaceId, "workspace");
    this.host = options.host ?? "local";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.pageSize = options.pageSize ?? 50;
    this.maxPages = options.maxPages ?? 100;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000 ||
      !Number.isInteger(this.pageSize) ||
      this.pageSize < 1 ||
      this.pageSize > 100 ||
      !Number.isInteger(this.maxPages) ||
      this.maxPages < 1 ||
      this.maxPages > 100
    ) {
      throw failure("MULTICA_INVALID_ARGUMENT", "Invalid Multica bounds");
    }
    this.writeEnabled = options.writeEnabled === true;
    if (options.allowedProjectIds !== undefined && !Array.isArray(options.allowedProjectIds)) {
      throw failure("MULTICA_INVALID_ARGUMENT", "allowedProjectIds must be an array");
    }
    this.allowedProjectIds =
      options.allowedProjectIds === undefined ? null : new Set(options.allowedProjectIds.map((x) => id(x, "project")));
    this.runCommand = options.runCommand ?? nativeCommand;
  }

  get capabilities() {
    const writable = this.writeEnabled && this.allowedProjectIds !== null && this.allowedProjectIds.size > 0;
    return { read: true, continue: writable, cancel: writable };
  }

  _scope(projectId) {
    id(projectId, "project");
    if (this.allowedProjectIds !== null && !this.allowedProjectIds.has(projectId)) {
      throw failure("MULTICA_SCOPE_DENIED", "Project is outside the configured scope");
    }
  }

  _workspace(row) {
    if (this.workspaceId && row.workspace_id !== undefined && row.workspace_id !== this.workspaceId) {
      throw failure("MULTICA_SCOPE_DENIED", "Response belongs to another workspace");
    }
  }

  async _call(args, { input } = {}) {
    const prefix = [
      ...(this.profile ? ["--profile", this.profile] : []),
      ...(this.workspaceId ? ["--workspace-id", this.workspaceId] : []),
    ];
    const controller = new AbortController();
    let timer;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() =>
          this.runCommand(this.command, [...prefix, ...args], {
            shell: false,
            encoding: "utf8",
            timeout: this.timeoutMs,
            killSignal: "SIGTERM",
            maxBuffer: 8 * 1024 * 1024,
            signal: controller.signal,
            ...(input === undefined ? {} : { input }),
          }),
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(failure("MULTICA_TIMEOUT", "Multica command timed out"));
          }, this.timeoutMs);
        }),
      ]);
      if (!object(response) || response.exitCode !== 0 || typeof response.stdout !== "string") {
        throw failure("MULTICA_COMMAND_FAILED", "Multica command did not succeed");
      }
      let value;
      try {
        value = JSON.parse(response.stdout);
      } catch {
        throw failure("MULTICA_INVALID_JSON", "Multica returned invalid JSON");
      }
      if (object(value) && (value.ok === false || value.success === false || value.error)) {
        throw failure("MULTICA_COMMAND_FAILED", "Multica returned an error");
      }
      return value;
    } catch (error) {
      if (typeof error?.code === "string" && error.code.startsWith("MULTICA_")) throw error;
      throw failure("MULTICA_COMMAND_FAILED", "Multica command could not be completed");
    } finally {
      clearTimeout(timer);
    }
  }

  async listProjects() {
    const rows = await this._call(["project", "list", "--output", "json"]);
    if (!Array.isArray(rows)) throw failure("MULTICA_INVALID_RESPONSE", "Expected a native Multica project list");
    const projects = [];
    const seen = new Set();
    for (const row of rows) {
      if (!object(row) || typeof row.id !== "string" || typeof row.title !== "string" || seen.has(row.id)) {
        throw failure("MULTICA_INVALID_RESPONSE", "Invalid or repeated native project");
      }
      id(row.id, "project");
      this._workspace(row);
      seen.add(row.id);
      if (this.allowedProjectIds !== null && !this.allowedProjectIds.has(row.id)) continue;
      projects.push({
        provider: "multica",
        host: this.host,
        nativeId: row.id,
        name: row.title,
        roots: [],
        nativeState: typeof row.status === "string" ? row.status : null,
        updatedAt: timestamp(row.updated_at),
        capabilities: this.capabilities,
      });
    }
    return { projects, observedAt: new Date().toISOString(), complete: true };
  }

  _issue(row, expectedProject) {
    if (
      !object(row) ||
      typeof row.id !== "string" ||
      typeof row.project_id !== "string" ||
      typeof row.title !== "string" ||
      typeof row.status !== "string"
    ) {
      throw failure("MULTICA_INVALID_RESPONSE", "Invalid native Issue metadata");
    }
    id(row.id, "issue");
    this._scope(row.project_id);
    this._workspace(row);
    if (expectedProject && row.project_id !== expectedProject) {
      throw failure("MULTICA_SCOPE_DENIED", "Issue belongs to another project");
    }
    return {
      provider: "multica",
      host: this.host,
      nativeId: row.id,
      projectId: row.project_id,
      title: row.title,
      state: "unknown",
      nativeState: row.status,
      issueState: row.status,
      executionState: "unobserved",
      updatedAt: timestamp(row.updated_at),
      businessComplete: null,
      assigneeType: typeof row.assignee_type === "string" ? row.assignee_type : null,
      assigneeId: row.assignee_type === "agent" && typeof row.assignee_id === "string" ? row.assignee_id : null,
    };
  }

  async listWork(projectId) {
    this._scope(projectId);
    const items = [];
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < this.maxPages; page++) {
      const response = await this._call([
        "issue",
        "list",
        "--project",
        projectId,
        "--limit",
        String(this.pageSize),
        "--offset",
        String(offset),
        "--sort",
        "created_at",
        "--direction",
        "asc",
        "--output",
        "json",
      ]);
      if (
        !object(response) ||
        !Array.isArray(response.issues) ||
        typeof response.has_more !== "boolean" ||
        !Number.isInteger(response.offset) ||
        response.offset !== offset ||
        !Number.isInteger(response.total) ||
        response.total < 0
      ) {
        throw failure("MULTICA_INVALID_RESPONSE", "Invalid Issue pagination");
      }
      if (response.has_more && response.issues.length === 0) {
        throw failure("MULTICA_INVALID_RESPONSE", "Issue pagination made no progress");
      }
      for (const row of response.issues) {
        const item = this._issue(row, projectId);
        if (seen.has(item.nativeId)) throw failure("MULTICA_INVALID_RESPONSE", "Issue pagination repeated an item");
        seen.add(item.nativeId);
        items.push(item);
      }
      offset += response.issues.length;
      if (!response.has_more) {
        if (offset !== response.total)
          throw failure("MULTICA_INVALID_RESPONSE", "Issue list changed or was truncated; retry the read");
        return { items, observedAt: new Date().toISOString(), complete: true };
      }
    }
    throw failure("MULTICA_LIMIT_REACHED", "Issue pagination exceeded its configured bound");
  }

  async _read(nativeId) {
    id(nativeId, "issue");
    const issue = await this._call(["issue", "get", nativeId, "--output", "json"]);
    const item = this._issue(issue);
    if (issue.id !== nativeId && issue.identifier !== nativeId) {
      throw failure("MULTICA_INVALID_RESPONSE", "Issue identity changed");
    }
    const rows = await this._call(["issue", "runs", issue.id, "--output", "json"]);
    if (!Array.isArray(rows)) throw failure("MULTICA_INVALID_RESPONSE", "Invalid native execution list");
    const runs = rows
      .map((row) => {
        if (!object(row) || typeof row.id !== "string" || typeof row.status !== "string" || row.issue_id !== issue.id) {
          throw failure("MULTICA_INVALID_RESPONSE", "Execution does not belong to this Issue");
        }
        id(row.id, "execution");
        return {
          nativeId: row.id,
          state: row.status,
          createdAt: timestamp(row.created_at),
          startedAt: timestamp(row.started_at),
          finishedAt: timestamp(row.completed_at),
        };
      })
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.nativeId.localeCompare(a.nativeId));
    const active = runs.filter((r) => ACTIVE.has(r.state));
    const latest = active[0] ?? runs[0];
    return {
      ...item,
      state: latest?.state ?? "unknown",
      executionState: latest?.state ?? "unobserved",
      ...(latest && { executionId: latest.nativeId }),
      activeExecutionIds: active.map((r) => r.nativeId),
      runs,
      observedAt: new Date().toISOString(),
      capabilities: this.capabilities,
    };
  }

  async readWork(nativeId) {
    return this._read(nativeId);
  }

  _write() {
    if (!this.writeEnabled) throw failure("MULTICA_READ_ONLY", "Multica writes are disabled");
    if (this.allowedProjectIds === null || this.allowedProjectIds.size === 0) {
      throw failure("MULTICA_SCOPE_REQUIRED", "Multica writes require an explicit project allowlist");
    }
  }

  async continueWork({ nativeId, text, requestId, beforeMutation } = {}) {
    this._write();
    id(nativeId, "issue");
    id(requestId, "request");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 128 * 1024 ||
      text.includes("\0") ||
      /mention:\/\//i.test(text)
    ) {
      throw failure("MULTICA_INVALID_ARGUMENT", "Task text must be bounded and must not contain native mention markup");
    }
    const before = await this._read(nativeId);
    if (before.activeExecutionIds.length)
      throw failure("MULTICA_BUSY", "Issue already has queued or running executions");
    if (before.runs.some((run) => !TERMINAL.has(run.state)))
      throw failure("MULTICA_STATE_UNKNOWN", "An execution has an unknown lifecycle state");
    const agent = before.assigneeId;
    if (
      before.assigneeType !== "agent" ||
      typeof agent !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(agent)
    ) {
      throw failure("MULTICA_UNSUPPORTED", "Issue followup requires an existing exact agent assignee");
    }
    // The caller must persist requestId before calling. This API has no remote idempotency key;
    // an uncertain write must remain unknown in the caller's durable ledger, never be re-sent.
    // Explicit native markup gives a per-target trigger_outcomes acknowledgement. Plain @name does not.
    // Verified against the installed CLI commit 19155e41f: comments/mentioning-agents and cmd_issue.go.
    const content = `<!-- personal-loop-operation:${requestId} -->\n[@assigned agent](mention://agent/${agent})\n\n${text}`;
    let response;
    // The control check stays outside the write catch: a local pause is not an uncertain remote outcome.
    beforeWrite(beforeMutation);
    try {
      response = await this._call(["issue", "comment", "add", before.nativeId, "--content-stdin", "--output", "json"], {
        input: content,
      });
    } catch {
      throw failure(
        "MULTICA_WRITE_UNCERTAIN",
        "Followup may have been posted; reconcile the operation record before taking further action",
      );
    }
    if (
      !object(response) ||
      typeof response.id !== "string" ||
      !identifier.test(response.id) ||
      response.issue_id !== before.nativeId ||
      !Array.isArray(response.trigger_outcomes)
    ) {
      throw failure(
        "MULTICA_WRITE_UNCERTAIN",
        "Followup response did not prove its comment identity and trigger outcome",
      );
    }
    const outcomes = response.trigger_outcomes.filter(
      (x) => object(x) && x.target_type === "agent" && x.target_id === agent,
    );
    if (
      response.trigger_outcomes.length !== 1 ||
      outcomes.length !== 1 ||
      !["queued", "coalesced", "deferred", "blocked"].includes(outcomes[0].status)
    ) {
      throw failure(
        "MULTICA_WRITE_UNCERTAIN",
        "Followup target activation is unknown; do not submit it again automatically",
      );
    }
    const outcome = outcomes[0];
    return {
      accepted: outcome.status !== "blocked",
      commentPosted: true,
      triggerConfirmed: outcome.status !== "blocked",
      nativeId: before.nativeId,
      projectId: before.projectId,
      commentId: response.id,
      requestId,
      executionId: null,
      dispatchState: outcome.status,
      mode: outcome.status === "queued" ? "issue-followup-new-run" : `issue-followup-${outcome.status}`,
      preservesModelSession: false,
      reasonCode: typeof outcome.reason_code === "string" ? outcome.reason_code : null,
      observedAt: new Date().toISOString(),
    };
  }

  async cancelWork({ nativeId, executionId, beforeMutation } = {}) {
    this._write();
    id(nativeId, "issue");
    id(executionId, "execution");
    const before = await this._read(nativeId);
    const execution = before.runs.find((r) => r.nativeId === executionId);
    if (!execution) throw failure("MULTICA_EXECUTION_MISMATCH", "Exact execution was not found in this Issue");
    if (TERMINAL.has(execution.state)) {
      return {
        accepted: false,
        alreadyTerminal: true,
        confirmedStopped: true,
        executionId,
        nativeId: before.nativeId,
        observedAt: new Date().toISOString(),
      };
    }
    if (!ACTIVE.has(execution.state))
      throw failure("MULTICA_UNSUPPORTED", "Unknown execution state; cancellation was not submitted");
    if (execution.state === "cancelling") {
      return {
        accepted: true,
        alreadyRequested: true,
        confirmedStopped: false,
        executionId,
        nativeId: before.nativeId,
        observedAt: new Date().toISOString(),
      };
    }
    beforeWrite(beforeMutation);
    try {
      const acknowledgement = await this._call([
        "issue",
        "cancel-task",
        executionId,
        "--issue",
        before.nativeId,
        "--output",
        "json",
      ]);
      if (!object(acknowledgement)) throw failure("MULTICA_INVALID_RESPONSE", "Invalid cancellation acknowledgement");
    } catch {
      throw failure(
        "MULTICA_WRITE_UNCERTAIN",
        "Cancellation outcome is unknown; inspect this exact execution before retrying",
      );
    }
    let after;
    try {
      after = await this._read(before.nativeId);
    } catch {
      return {
        accepted: true,
        confirmedStopped: false,
        verificationUnavailable: true,
        executionId,
        nativeId: before.nativeId,
        observedAt: new Date().toISOString(),
      };
    }
    const observed = after.runs.find((r) => r.nativeId === executionId);
    return {
      accepted: true,
      confirmedStopped: Boolean(observed && TERMINAL.has(observed.state)),
      executionId,
      nativeId: before.nativeId,
      executionState: observed?.state ?? "unknown",
      observedAt: after.observedAt,
    };
  }
}
