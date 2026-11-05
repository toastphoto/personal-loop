// Guards against shell injection, silently incomplete catalogues, unsafe writes and confusing Issue state with execution state.
import test from "node:test";
import assert from "node:assert/strict";
import { MulticaConnector } from "./multica.mjs";

const project = { id: "project-1", title: "Example", status: "started", workspace_id: "workspace-1" };
const issue = {
  id: "issue-1",
  identifier: "TEST-1",
  project_id: "project-1",
  title: "Fix example",
  status: "done",
  updated_at: "2026-11-05T00:00:00Z",
  workspace_id: "workspace-1",
};
const assignedAgent = "12345678-1234-1234-1234-123456789abc";
const assignedIssue = { ...issue, assignee_id: assignedAgent, assignee_type: "agent" };
const run = { id: "run-1", issue_id: "issue-1", status: "running", created_at: "2026-11-05T00:00:00Z" };
const output = (data) => ({ stdout: JSON.stringify(data), exitCode: 0 });
const options = (runCommand, extra = {}) => ({ profile: "test", workspaceId: "workspace-1", runCommand, ...extra });

test("catalogue uses native IDs, does not invent roots or leak description", async () => {
  const calls = [];
  const c = new MulticaConnector(
    options(async (command, args, opts) => {
      calls.push({ command, args, opts });
      return output([{ ...project, description: "private body", custom_secret: "hidden" }]);
    }),
  );
  const result = await c.listProjects();
  assert.equal(result.complete, true);
  assert.deepEqual(result.projects[0].roots, []);
  assert.equal(result.projects[0].nativeId, "project-1");
  assert.equal(result.projects[0].capabilities.continue, false);
  assert.equal(JSON.stringify(result).includes("private body"), false);
  assert.equal(JSON.stringify(result).includes("hidden"), false);
  assert.deepEqual(calls[0].args, [
    "--profile",
    "test",
    "--workspace-id",
    "workspace-1",
    "project",
    "list",
    "--output",
    "json",
  ]);
  assert.equal(calls[0].opts.shell, false);
});

test("project allowlist limits both catalogue and work reads", async () => {
  const c = new MulticaConnector(
    options(async () => output([project, { ...project, id: "project-2" }]), { allowedProjectIds: ["project-1"] }),
  );
  assert.equal((await c.listProjects()).projects.length, 1);
  await assert.rejects(c.listWork("project-2"), { code: "MULTICA_SCOPE_DENIED" });
});

test("paginated issues are complete and preserve issue state without asserting execution completion", async () => {
  let page = 0;
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        assert.equal(args.includes("--offset"), true);
        page++;
        return output(
          page === 1
            ? { issues: [issue], has_more: true, offset: 0, limit: 1, total: 2 }
            : { issues: [{ ...issue, id: "issue-2" }], has_more: false, offset: 1, limit: 1, total: 2 },
        );
      },
      { pageSize: 1 },
    ),
  );
  const result = await c.listWork("project-1");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].state, "unknown");
  assert.equal(result.items[0].nativeState, "done");
  assert.equal(result.items[0].businessComplete, null);
});

test("pagination must advance, rather than silently repeating or declaring a partial list complete", async () => {
  const c = new MulticaConnector(
    options(async () => output({ issues: [issue], has_more: true, offset: 0, limit: 1, total: 20 }), { pageSize: 1 }),
  );
  await assert.rejects(c.listWork("project-1"), { code: "MULTICA_INVALID_RESPONSE" });
});

test("wrong workspace/project response is rejected", async () => {
  const c = new MulticaConnector(options(async () => output([{ ...project, workspace_id: "different" }])));
  await assert.rejects(c.listProjects(), { code: "MULTICA_SCOPE_DENIED" });
  const d = new MulticaConnector(
    options(async () =>
      output({ issues: [{ ...issue, project_id: "other" }], has_more: false, offset: 0, limit: 50, total: 1 }),
    ),
  );
  await assert.rejects(d.listWork("project-1"), { code: "MULTICA_SCOPE_DENIED" });
});

test("readWork reports running execution even when parent Issue says done", async () => {
  const c = new MulticaConnector(
    options(async (_command, args) =>
      output(args.includes("runs") ? [run] : { ...issue, description: "private body" }),
    ),
  );
  const result = await c.readWork("issue-1");
  assert.equal(result.state, "running");
  assert.equal(result.nativeState, "done");
  assert.equal(result.executionState, "running");
  assert.equal(result.businessComplete, null);
  assert.equal(JSON.stringify(result).includes("private body"), false);
});

test("invalid JSON, error envelopes and nonzero command exits are explicit and redact diagnostics", async () => {
  const cases = [
    [{ stdout: "bad json", exitCode: 0 }, "MULTICA_INVALID_JSON"],
    [output({ ok: false, error: "secret output" }), "MULTICA_COMMAND_FAILED"],
    [{ stdout: "", stderr: "sensitive diagnostics", exitCode: 2 }, "MULTICA_COMMAND_FAILED"],
    [output({ unexpected: [] }), "MULTICA_INVALID_RESPONSE"],
  ];
  for (const [response, code] of cases) {
    const c = new MulticaConnector(options(async () => response));
    await assert.rejects(c.listProjects(), (error) => error.code === code && !/secret|sensitive/.test(error.message));
  }
});

test("timeout applies even when an injected command never resolves", async () => {
  const c = new MulticaConnector(options(async () => new Promise(() => {}), { timeoutMs: 15 }));
  await assert.rejects(c.listProjects(), { code: "MULTICA_TIMEOUT" });
});

test("writes are disabled by default without making any native call", async () => {
  let calls = 0;
  const c = new MulticaConnector(
    options(async () => {
      calls++;
      return output({});
    }),
  );
  await assert.rejects(c.continueWork({ nativeId: "issue-1", text: "continue", requestId: "request-1" }), {
    code: "MULTICA_READ_ONLY",
  });
  await assert.rejects(c.cancelWork({ nativeId: "issue-1", executionId: "run-1" }), { code: "MULTICA_READ_ONLY" });
  assert.equal(calls, 0);
});

test("continuation rejects a non-agent Issue assignee", async () => {
  const calls = [];
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        calls.push(args);
        return output(args.includes("runs") ? [] : issue);
      },
      { writeEnabled: true, allowedProjectIds: ["project-1"] },
    ),
  );
  await assert.rejects(c.continueWork({ nativeId: "issue-1", text: "continue", requestId: "request-1" }), {
    code: "MULTICA_UNSUPPORTED",
  });
  assert.equal(
    calls.some((args) => args.includes("add") || args.includes("rerun")),
    false,
  );
});

test("cancellation requires an allowlist and an exact execution belonging to the Issue", async () => {
  const unscoped = new MulticaConnector(options(async () => output({}), { writeEnabled: true }));
  await assert.rejects(unscoped.cancelWork({ nativeId: "issue-1", executionId: "run-1" }), {
    code: "MULTICA_SCOPE_REQUIRED",
  });
  const c = new MulticaConnector(
    options(async (_command, args) => output(args.includes("runs") ? [run] : issue), {
      writeEnabled: true,
      allowedProjectIds: ["project-1"],
    }),
  );
  await assert.rejects(c.cancelWork({ nativeId: "issue-1", executionId: "unrelated-run" }), {
    code: "MULTICA_EXECUTION_MISMATCH",
  });
});

test("cancel acknowledgement is not reported as confirmed stop while runtime remains active", async () => {
  const calls = [];
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        calls.push(args);
        return output(args.includes("cancel-task") ? { accepted: true } : args.includes("runs") ? [run] : issue);
      },
      { writeEnabled: true, allowedProjectIds: ["project-1"] },
    ),
  );
  const result = await c.cancelWork({ nativeId: "issue-1", executionId: "run-1" });
  assert.equal(result.accepted, true);
  assert.equal(result.confirmedStopped, false);
  assert.equal(calls.filter((args) => args.includes("cancel-task")).length, 1);
});

test("unknown cancellation delivery is surfaced and never auto-retried", async () => {
  let writes = 0;
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        if (args.includes("cancel-task")) {
          writes++;
          throw new Error("secret transport details");
        }
        return output(args.includes("runs") ? [run] : issue);
      },
      { writeEnabled: true, allowedProjectIds: ["project-1"] },
    ),
  );
  await assert.rejects(c.cancelWork({ nativeId: "issue-1", executionId: "run-1" }), {
    code: "MULTICA_WRITE_UNCERTAIN",
  });
  assert.equal(writes, 1);
});

test("flag-like IDs are rejected before spawning a command", async () => {
  const c = new MulticaConnector(
    options(async () => {
      throw new Error("must not execute");
    }),
  );
  await assert.rejects(c.listWork("--help"), { code: "MULTICA_INVALID_ARGUMENT" });
});

test("Issue followup uses stdin and explicit current-agent mention, returning new-run semantics", async () => {
  const calls = [];
  const body = "Keep \u005c\u005cn literal and 中文\nsecond line";
  const c = new MulticaConnector(
    options(
      async (_command, args, opts) => {
        calls.push({ args, opts });
        if (args.includes("add"))
          return output({
            id: "comment-1",
            issue_id: "issue-1",
            trigger_outcomes: [
              { target_type: "agent", target_id: assignedAgent, status: "queued", reason_code: "queued" },
            ],
          });
        return output(args.includes("runs") ? [] : assignedIssue);
      },
      { writeEnabled: true, allowedProjectIds: ["project-1"] },
    ),
  );
  const result = await c.continueWork({ nativeId: "issue-1", text: body, requestId: "request-1" });
  const mutation = calls.find((x) => x.args.includes("add"));
  assert.equal(mutation.args.includes("--content-stdin"), true);
  assert.equal(mutation.args.includes(body), false);
  assert.equal(mutation.opts.input.includes(body), true);
  assert.equal(mutation.opts.input.includes("mention://agent/" + assignedAgent), true);
  assert.equal(result.accepted, true);
  assert.equal(result.commentId, "comment-1");
  assert.equal(result.mode, "issue-followup-new-run");
  assert.equal(result.preservesModelSession, false);
  assert.equal(result.executionId, null);
});

test("followup refuses busy Issue and extra mention markup without any mutation", async () => {
  const calls = [];
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        calls.push(args);
        return output(args.includes("runs") ? [run] : assignedIssue);
      },
      { writeEnabled: true, allowedProjectIds: ["project-1"] },
    ),
  );
  await assert.rejects(c.continueWork({ nativeId: "issue-1", text: "continue", requestId: "request-1" }), {
    code: "MULTICA_BUSY",
  });
  await assert.rejects(
    c.continueWork({ nativeId: "issue-1", text: "[@other](mention://agent/abc)", requestId: "request-2" }),
    { code: "MULTICA_INVALID_ARGUMENT" },
  );
  assert.equal(
    calls.some((args) => args.includes("add")),
    false,
  );
});

test("comment saved but trigger blocked is not reported as accepted execution", async () => {
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        if (args.includes("add"))
          return output({
            id: "comment-1",
            issue_id: "issue-1",
            trigger_outcomes: [
              { target_type: "agent", target_id: assignedAgent, status: "blocked", reason_code: "runtime_offline" },
            ],
          });
        return output(args.includes("runs") ? [] : assignedIssue);
      },
      { writeEnabled: true, allowedProjectIds: ["project-1"] },
    ),
  );
  const result = await c.continueWork({ nativeId: "issue-1", text: "continue", requestId: "request-1" });
  assert.equal(result.accepted, false);
  assert.equal(result.commentPosted, true);
  assert.equal(result.dispatchState, "blocked");
  assert.equal(result.reasonCode, "runtime_offline");
});

test("coalesced and deferred followups never claim a fresh execution", async () => {
  for (const status of ["coalesced", "deferred"]) {
    const c = new MulticaConnector(
      options(
        async (_command, args) => {
          if (args.includes("add"))
            return output({
              id: "comment-1",
              issue_id: "issue-1",
              trigger_outcomes: [{ target_type: "agent", target_id: assignedAgent, status, reason_code: status }],
            });
          return output(args.includes("runs") ? [] : assignedIssue);
        },
        { writeEnabled: true, allowedProjectIds: ["project-1"] },
      ),
    );
    const result = await c.continueWork({ nativeId: "issue-1", text: "continue", requestId: "request-1" });
    assert.equal(result.accepted, true);
    assert.equal(result.mode, "issue-followup-" + status);
    assert.equal(result.preservesModelSession, false);
  }
});

test("unknown followup response is uncertain and is never automatically resent", async () => {
  let writes = 0;
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        if (args.includes("add")) {
          writes++;
          return output({ id: "comment-1", issue_id: "issue-1" });
        }
        return output(args.includes("runs") ? [] : assignedIssue);
      },
      { writeEnabled: true, allowedProjectIds: ["project-1"] },
    ),
  );
  await assert.rejects(c.continueWork({ nativeId: "issue-1", text: "continue", requestId: "request-1" }), {
    code: "MULTICA_WRITE_UNCERTAIN",
  });
  assert.equal(writes, 1);
});

test("unknown native execution states block followup before mutation", async () => {
  let writes = 0;
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        if (args.includes("add")) writes++;
        return output(args.includes("runs") ? [{ ...run, status: "new-future-state" }] : assignedIssue);
      },
      { writeEnabled: true, allowedProjectIds: ["project-1"] },
    ),
  );
  await assert.rejects(c.continueWork({ nativeId: "issue-1", text: "continue", requestId: "request-1" }), {
    code: "MULTICA_STATE_UNKNOWN",
  });
  assert.equal(writes, 0);
});

test("pause after followup preflight is checked before comment submission and keeps the original control error", async () => {
  let active = true;
  let writes = 0;
  let checks = 0;
  const controlError = Object.assign(new Error("Loop paused"), { code: "LOOP_NOT_ACTIVE" });
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        if (args.includes("add")) writes++;
        if (args.includes("runs")) {
          active = false;
          return output([]);
        }
        return output(assignedIssue);
      },
      { writeEnabled: true, allowedProjectIds: ["project-1"] },
    ),
  );
  await assert.rejects(
    c.continueWork({
      nativeId: "issue-1",
      text: "continue",
      requestId: "request-1",
      beforeMutation() {
        checks++;
        if (!active) throw controlError;
      },
    }),
    (error) => error === controlError,
  );
  assert.equal(checks, 1);
  assert.equal(writes, 0);
});

test("control revision changes during cancellation preflight block the native write without uncertain classification", async () => {
  let revision = 1;
  let writes = 0;
  const controlError = Object.assign(new Error("Revision changed"), { code: "CONTROL_REVISION_CHANGED" });
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        if (args.includes("cancel-task")) writes++;
        if (args.includes("runs")) {
          revision = 2;
          return output([run]);
        }
        return output(assignedIssue);
      },
      { writeEnabled: true, allowedProjectIds: ["project-1"] },
    ),
  );
  await assert.rejects(
    c.cancelWork({
      nativeId: "issue-1",
      executionId: "run-1",
      beforeMutation() {
        if (revision !== 1) throw controlError;
      },
    }),
    (error) => error === controlError,
  );
  assert.equal(writes, 0);
});

test("conversation previews are disabled before any native command unless explicitly allowed", async () => {
  let calls = 0;
  const c = new MulticaConnector(
    options(async () => {
      calls++;
      return output({});
    }),
  );
  await assert.rejects(c.readConversation("issue-1"), { code: "MULTICA_CONVERSATION_DISABLED" });
  assert.equal(calls, 0);
});
test("conversation preview validates the expected project and Issue before reading message bodies", async () => {
  const calls = [];
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        calls.push(args);
        return output(issue);
      },
      { allowConversationPreview: true },
    ),
  );
  await assert.rejects(c.readConversation("issue-1", { projectId: "other-project" }), { code: "MULTICA_SCOPE_DENIED" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("run-messages"), false);
  const wrong = new MulticaConnector(
    options(async () => output({ ...issue, id: "other-issue", identifier: "OTHER-1" }), {
      allowConversationPreview: true,
    }),
  );
  await assert.rejects(wrong.readConversation("issue-1"), { code: "MULTICA_INVALID_RESPONSE" });
});
test("latest active Run is preferred and only its last text message is returned", async () => {
  const calls = [];
  const selected = { ...run, id: "active-run", created_at: "2026-11-05T00:00:00Z" };
  const finished = { ...run, id: "later-finished", status: "completed", created_at: "2026-11-05T01:00:00Z" };
  const messages = [
    {
      task_id: "active-run",
      seq: 5,
      type: "thinking",
      content: "private thoughts",
      created_at: "2026-11-05T01:10:02Z",
    },
    {
      task_id: "active-run",
      seq: 4,
      type: "text",
      content: "Latest visible reply",
      created_at: "2026-11-05T01:10:01Z",
    },
    {
      task_id: "active-run",
      seq: 6,
      type: "tool_result",
      content: "private tool data",
      created_at: "2026-11-05T01:10:03Z",
    },
    { task_id: "active-run", seq: 2, type: "text", content: "Older visible reply", created_at: "2026-11-05T01:00:00Z" },
  ];
  const c = new MulticaConnector(
    options(
      async (_command, args, opts) => {
        calls.push({ args, opts });
        return output(args.includes("run-messages") ? messages : args.includes("runs") ? [finished, selected] : issue);
      },
      { allowConversationPreview: true },
    ),
  );
  const result = await c.readConversation("TEST-1", { projectId: "project-1" });
  assert.equal(result.nativeId, "issue-1");
  assert.equal(result.projectId, "project-1");
  assert.equal(result.state, "running");
  assert.equal(result.runtimeStateTrusted, true);
  assert.equal(result.latestReply.text, "Latest visible reply");
  assert.equal(result.latestReply.id, "active-run:4");
  assert.equal(result.latestReply.phase, "progress");
  assert.equal(result.latestReply.at, "2026-11-05T01:10:01Z");
  assert.equal(result.complete, true);
  assert.ok(!JSON.stringify(result).includes("private thoughts"));
  assert.ok(!JSON.stringify(result).includes("private tool data"));
  const call = calls.find((c) => c.args.includes("run-messages"));
  assert.deepEqual(call.args.slice(-6), ["run-messages", "active-run", "--issue", "issue-1", "--output", "json"]);
  assert.equal(call.opts.shell, false);
  assert.ok(call.opts.maxBuffer <= 256 * 1024);
});
test("wrong Issue Run or a foreign task_id in any message rejects the preview", async () => {
  let messagesCalled = false;
  const badRun = new MulticaConnector(
    options(
      async (_command, args) => {
        if (args.includes("run-messages")) messagesCalled = true;
        return output(args.includes("runs") ? [{ ...run, issue_id: "other-issue" }] : issue);
      },
      { allowConversationPreview: true },
    ),
  );
  await assert.rejects(badRun.readConversation("issue-1"), { code: "MULTICA_INVALID_RESPONSE" });
  assert.equal(messagesCalled, false);
  const foreign = new MulticaConnector(
    options(
      async (_command, args) =>
        output(
          args.includes("run-messages")
            ? [
                { task_id: "run-1", seq: 1, type: "text", content: "valid" },
                { task_id: "foreign-run", seq: 2, type: "tool_result", content: "hidden" },
              ]
            : args.includes("runs")
              ? [run]
              : issue,
        ),
      { allowConversationPreview: true },
    ),
  );
  await assert.rejects(foreign.readConversation("issue-1"), { code: "MULTICA_EXECUTION_MISMATCH" });
});
test("empty or non-text results do not invent an Agent reply from errors or wait reasons", async () => {
  for (const messages of [
    [],
    [{ task_id: "run-1", seq: 1, type: "thinking", content: "secret" }],
    [{ task_id: "run-1", seq: 1, type: "text", content: "   " }],
  ]) {
    const c = new MulticaConnector(
      options(
        async (_command, args) =>
          output(
            args.includes("run-messages")
              ? messages
              : args.includes("runs")
                ? [{ ...run, error: "private error", wait_reason: "private reason" }]
                : issue,
          ),
        { allowConversationPreview: true },
      ),
    );
    const result = await c.readConversation("issue-1");
    assert.equal(result.latestReply, null);
    assert.equal(result.reason, "NO_TEXT_REPLY");
    assert.equal(result.complete, true);
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
});
test("no Run is an explicit empty preview without querying message history", async () => {
  let calls = 0;
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        calls++;
        return output(args.includes("runs") ? [] : issue);
      },
      { allowConversationPreview: true },
    ),
  );
  const result = await c.readConversation("issue-1");
  assert.equal(result.latestReply, null);
  assert.equal(result.reason, "NO_RUN");
  assert.equal(calls, 2);
});
test("preview truncation respects Unicode characters and marks the excerpt", async () => {
  const c = new MulticaConnector(
    options(
      async (_command, args) =>
        output(
          args.includes("run-messages")
            ? [
                {
                  task_id: "run-1",
                  seq: 1,
                  type: "text",
                  content: "你好🙂世界更多内容",
                  created_at: "2026-11-05T00:00:02Z",
                },
              ]
            : args.includes("runs")
              ? [{ ...run, status: "completed", completed_at: "2026-11-05T00:00:03Z" }]
              : issue,
        ),
      { allowConversationPreview: true },
    ),
  );
  const result = await c.readConversation("issue-1", { maxChars: 4 });
  assert.equal(result.latestReply.text, "你好🙂世");
  assert.equal(result.latestReply.truncated, true);
  assert.equal(result.latestReply.phase, "final");
  await assert.rejects(c.readConversation("issue-1", { maxChars: 0 }), { code: "MULTICA_INVALID_ARGUMENT" });
});
test("oversized message output is rejected even when a test transport ignores maxBuffer", async () => {
  const c = new MulticaConnector(
    options(
      async (_command, args) =>
        output(
          args.includes("run-messages")
            ? [{ task_id: "run-1", seq: 1, type: "text", content: "private".repeat(50000) }]
            : args.includes("runs")
              ? [run]
              : issue,
        ),
      { allowConversationPreview: true },
    ),
  );
  await assert.rejects(c.readConversation("issue-1"), { code: "MULTICA_RESPONSE_TOO_LARGE" });
});
test("readWork stays metadata-only even when conversation previews are enabled", async () => {
  const c = new MulticaConnector(
    options(
      async (_command, args) =>
        output(
          args.includes("runs")
            ? [
                {
                  ...run,
                  result: { comment: "private final reply" },
                  error: "private error",
                  wait_reason: "private wait",
                },
              ]
            : { ...issue, description: "private issue body" },
        ),
      { allowConversationPreview: true },
    ),
  );
  const result = await c.readWork("issue-1");
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal(Object.hasOwn(result, "latestReply"), false);
});

test("conversation previews reject wrong-workspace and duplicate execution metadata", async () => {
  for (const rows of [[{ ...run, workspace_id: "foreign-workspace" }], [run, { ...run, status: "completed" }]]) {
    const c = new MulticaConnector(
      options(async (_command, args) => output(args.includes("runs") ? rows : issue), {
        allowConversationPreview: true,
      }),
    );
    await assert.rejects(c.readConversation("issue-1"), {
      code: rows.length === 1 ? "MULTICA_SCOPE_DENIED" : "MULTICA_INVALID_RESPONSE",
    });
  }
});
test("latest active execution is selected by timestamp rather than timestamp spelling", async () => {
  const older = { ...run, id: "older-run", created_at: "2026-11-05T10:00:00+08:00" };
  const newer = { ...run, id: "newer-run", created_at: "2026-11-05T03:00:00Z" };
  const c = new MulticaConnector(
    options(
      async (_command, args) => {
        if (args.includes("run-messages")) {
          assert.equal(args[args.indexOf("run-messages") + 1], "newer-run");
          return output([{ task_id: "newer-run", seq: 1, type: "text", content: "newer reply" }]);
        }
        return output(args.includes("runs") ? [older, newer] : issue);
      },
      { allowConversationPreview: true },
    ),
  );
  assert.equal((await c.readConversation("issue-1")).latestReply.text, "newer reply");
});
