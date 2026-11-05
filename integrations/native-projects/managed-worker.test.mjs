// Prevent duplicate model dispatch, budget resets on resume, cross-project execution, and false completion after uncertain stops.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runManagedWorker } from "./managed-worker.mjs";
import { LoopControls } from "./controls.mjs";
import adapter from "../../plugins/native-managed/agent.ts";
import { DatabaseSync } from "node:sqlite";
import { readMessage, resultFrom, repairPrompt } from "../../worker/contract.ts";

function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "managed-worker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  mkdirSync(root);
  const key = "codex:local:project-1";
  const config = {
    version: 1,
    providers: {},
    controlsFile: path.join(dir, "controls.json"),
    managedCodex: { enabled: true, stateDir: path.join(dir, "private"), waitTimeoutMs: 1000 },
  };
  const controls = new LoopControls(config.controlsFile);
  const set = (mode, extra = {}) => controls.set(key, mode, { actor: "test", ...extra });
  set("active", { objective: "核对项目当前状态", maxSteps: 2 });
  const project = { key, provider: "codex", nativeId: "project-1", roots: [root] };
  const events = [],
    calls = [],
    instances = [];
  const catalog = {
    async refresh() {},
    resolve() {
      return { project };
    },
    async close() {},
  };
  const factory = (cfg) => {
    calls.push(["factory", cfg]);
    const mock = {
      state: "idle",
      activeTurnId: null,
      async createOwnedSession(args) {
        args.beforeMutation();
        calls.push(["create", args]);
        this.identity = { projectId: args.projectId, cwd: args.cwd, goalId: args.goalId, threadId: "thread-1" };
        await options.afterCreate?.(set);
        return { nativeId: "thread-1" };
      },
      async continueOwned(args) {
        args.beforeMutation();
        calls.push(["continue", args]);
        this.state = "running";
        this.activeTurnId = "turn-" + args.requestId.split(":").at(-1);
        if (options.uncertain)
          throw Object.assign(new Error("hidden private failure"), { code: "MANAGED_OUTCOME_UNKNOWN" });
        return { accepted: true, executionId: this.activeTurnId };
      },
      owned() {
        return { ...this.identity, activeTurnId: this.activeTurnId, state: this.state };
      },
      async readOwned() {
        return { state: this.state, activeTurnId: this.activeTurnId };
      },
      async waitForTurn(args) {
        calls.push(["wait", args]);
        if (options.signal && this.state === "running") {
          if (options.pauseBeforeSignal) set("paused");
          if (options.replaceTurn) this.activeTurnId = "different-turn";
          queueMicrotask(() => options.signal.abort());
          return new Promise(() => {});
        }
        if (options.uncertain) throw Object.assign(new Error("unknown"), { code: "MANAGED_RESULT_UNKNOWN" });
        this.state = "idle";
        this.activeTurnId = null;
        return {
          nativeId: "thread-1",
          executionId: options.wrongUsageTurn ? "other-turn" : args.turnId,
          status: options.signal ? "interrupted" : "completed",
          completionVerified: true,
          text:
            options.finalText ??
            '核查完成\n```agent-autoloop\n{"notice":[{"title":"已完成","text":"已核对项目"}]}\n```',
          sessionUsage: {
            input: 20 * calls.filter((c) => c[0] === "continue").length,
            output: 10 * calls.filter((c) => c[0] === "continue").length,
          },
          ...(options.missingUsage
            ? {}
            : { turnUsage: options.partialUsage ? { input: 20 } : { input: 20, output: 10, cached: 4 } }),
          turnUsageStatus: options.missingUsage ? "missing" : options.partialUsage ? "partial" : "complete",
          nativeUsage: {
            total: { inputTokens: 20 * calls.filter((c) => c[0] === "continue").length },
            last: { inputTokens: 3, outputTokens: 1, cachedInputTokens: 0 },
          },
        };
      },
      async cancelOwned(args) {
        args.beforeMutation();
        calls.push(["cancel", args]);
        this.state = "stopping";
        return { accepted: true };
      },
      async close(args) {
        calls.push(["close", args]);
        if (this.state !== "idle") throw Object.assign(new Error("active"), { code: "MANAGED_ACTIVE_TURNS" });
      },
    };
    instances.push(mock);
    return mock;
  };
  const run = (runId = "1", more = {}) =>
    runManagedWorker(
      { config, projectKey: key, prompt: "可信上游提示", runId, ...more },
      { controls, catalog, executorFactory: factory, emit: (e) => events.push(e), signal: options.signal?.signal },
    );
  return { dir, root, key, config, controls, project, events, calls, run, set, instances };
}

test("disabled, manual and expired goals never construct an executor", async (t) => {
  for (const mode of ["disabled", "manual", "expired"]) {
    const f = fixture(t);
    if (mode === "disabled") f.config.managedCodex.enabled = false;
    if (mode === "manual") f.set("manual");
    if (mode === "expired")
      f.controls.get = () => ({ mode: "active", objective: "x", maxSteps: 1, deadline: "2000-01-01T00:00:00Z" });
    const result = await f.run();
    assert.equal(result.state, "not-running");
    assert.equal(f.calls.length, 0);
  }
});

test("native identity and one absolute root are required before dispatch", async (t) => {
  for (const change of [
    (p) => (p.provider = "dsh"),
    (p) => (p.roots = ["relative"]),
    (p) => p.roots.push("/other"),
    (p) => (p.key = "codex:local:other"),
  ]) {
    const f = fixture(t);
    change(f.project);
    const result = await f.run();
    assert.equal(result.state, "needs-attention");
    assert.equal(f.calls.length, 0);
    assert.match(result.text, /agent-autoloop/);
    assert.doesNotMatch(result.text, /FAILED|没跑成/);
  }
});

test("one verified turn emits native session and preserves the final receipt in private output", async (t) => {
  const f = fixture(t),
    result = await f.run();
  assert.equal(result.state, "completed");
  assert.deepEqual(
    f.events.map((e) => e.type),
    ["native.started", "native.result"],
  );
  assert.equal(result.session, "thread-1");
  assert.deepEqual(result.cumulativeUsage, { input: 20, output: 10 });
  assert.deepEqual(result.usage, { input: 20, output: 10, cached: 4 });
  assert.equal(f.calls.find((c) => c[0] === "factory")[1].sandbox, "read-only");
  const create = f.calls.find((c) => c[0] === "create")[1],
    send = f.calls.find((c) => c[0] === "continue")[1];
  assert.equal(create.projectId, "project-1");
  assert.equal(create.cwd, f.root);
  assert.match(send.text, /核对项目当前状态/);
  assert.match(send.text, /可信上游提示/);
  assert.equal(JSON.parse(readFileSync(result.artifact, "utf8")).text, result.text);
  assert.equal(statSync(result.artifact).mode & 0o777, 0o600);
});

test("same upstream run replays without dispatch and pause/resume cannot reset the goal budget", async (t) => {
  const f = fixture(t);
  f.set("active", { maxSteps: 1 });
  const first = await f.run();
  const replay = await f.run("1", { prompt: "上游重试的资料路径改变" });
  assert.equal(replay.text, first.text);
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
  f.set("paused");
  f.set("active");
  const exhausted = await f.run("2");
  assert.equal(exhausted.state, "needs-attention");
  assert.match(exhausted.text, /步数/);
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
  f.set("active", { objective: "另一个明确目标" });
  assert.equal((await f.run("3")).state, "completed");
  const creations = f.calls.filter((c) => c[0] === "create").map((c) => c[1]);
  assert.notEqual(creations[0].goalId, creations[1].goalId);
});

test("a pause after session creation blocks the turn at its final mutation guard", async (t) => {
  const f = fixture(t, { afterCreate: (set) => set("paused") });
  const result = await f.run();
  assert.equal(result.state, "needs-attention");
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 0);
  assert.equal(f.calls.filter((c) => c[0] === "close").length, 1);
});

test("uncertain accepted execution stays pending, never retries or force-closes", async (t) => {
  const f = fixture(t, { uncertain: true });
  const first = await f.run(),
    again = await f.run();
  assert.equal(first.state, "unknown");
  assert.equal(again.state, "unknown");
  assert.notEqual((await f.run("2")).state, "completed");
  assert.match(first.text, /待你处理/);
  assert.doesNotMatch(first.text, /hidden private failure|FAILED|没跑成/);
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
  assert.ok(f.calls.filter((c) => c[0] === "close").every((c) => c[1] === undefined));
});

test("SIGTERM equivalent interrupts only the owned turn and waits for its terminal result", async (t) => {
  const f = fixture(t, { signal: new AbortController() });
  const result = await f.run();
  assert.equal(result.state, "needs-attention");
  assert.match(result.text, /停止/);
  const cancellation = f.calls.find((c) => c[0] === "cancel")[1];
  assert.equal(cancellation.threadId, "thread-1");
  assert.equal(cancellation.turnId, "turn-1");
  assert.equal(f.calls.filter((c) => c[0] === "wait").length, 2);
  assert.equal(f.instances[0].state, "idle");
});

test("adapter uses trusted config/project arguments and accepts only valid native result records", () => {
  const argv = adapter.command({
    command: ["/trusted/config.json", "codex:local:p"],
    prompt: "body",
    cwd: "/ignored",
    access: "full",
    contextFile: "",
    folder: "",
    session: "",
    resume: null,
  });
  assert.deepEqual(argv.slice(-3), ["/trusted/config.json", "codex:local:p", "body"]);
  const start = JSON.stringify({ type: "native.started", session: "t1" });
  assert.deepEqual(adapter.read(start, null, ""), { started: true, session: "t1" });
  const final = JSON.stringify({
    type: "native.result",
    session: "t1",
    text: "finished",
    usage: { input: 5, output: 2 },
    cumulativeUsage: { input: 50, output: 20 },
  });
  const result = adapter.read(start + "\n" + final, 0, "");
  assert.equal(result.text, "finished");
  assert.equal(result.finished, true);
  assert.deepEqual(result.usage, { input: 5, output: 2 });
  assert.equal(result.sessionUsage, undefined);
  assert.equal(adapter.read(JSON.stringify({ type: "native.result", text: 12 }), null, "").text, undefined);
  assert.match(adapter.read(start, 1, "secret stderr").text, /待你处理/);
  assert.doesNotMatch(adapter.read(start, 1, "secret stderr").text, /secret stderr/);
});

test("pause followed by SIGTERM can stop the exact owned turn without re-enabling the project", async (t) => {
  const f = fixture(t, { signal: new AbortController(), pauseBeforeSignal: true });
  const result = await f.run();
  assert.equal(f.controls.get(f.key).mode, "paused");
  assert.equal(result.state, "needs-attention");
  assert.equal(f.calls.find((c) => c[0] === "cancel")[1].turnId, "turn-1");
  assert.equal(f.instances[0].state, "idle");
});

test("stop never interrupts a different turn even within the owned thread", async (t) => {
  const f = fixture(t, { signal: new AbortController(), replaceTurn: true });
  const result = await f.run();
  assert.equal(result.state, "unknown");
  assert.equal(f.calls.filter((c) => c[0] === "cancel").length, 0);
});

test("overlapping claims for the same upstream run reserve and dispatch only once", async (t) => {
  let release, arrived;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const atCreate = new Promise((resolve) => {
    arrived = resolve;
  });
  const f = fixture(t, {
    afterCreate: () => {
      arrived();
      return waiting;
    },
  });
  const first = f.run();
  await atCreate;
  assert.equal((await f.run()).state, "unknown");
  release();
  assert.equal((await first).state, "completed");
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
});

test("two upstream runs in one owned session report each turn once, not cumulative totals", async (t) => {
  const f = fixture(t);
  const first = await f.run("1"),
    second = await f.run("2");
  const read = (result) => adapter.read(JSON.stringify({ type: "native.result", ...result }), 0, "");
  assert.equal(first.session, second.session);
  assert.deepEqual(second.cumulativeUsage, { input: 40, output: 20 });
  assert.equal(read(first).usage.input + read(second).usage.input, 40);
  assert.equal(read(first).usage.output + read(second).usage.output, 20);
  assert.equal(read(first).sessionUsage, undefined);
  assert.equal(read(second).sessionUsage, undefined);
});

test("missing per-turn usage is missing rather than zero or a guessed cumulative difference", async (t) => {
  const f = fixture(t, { missingUsage: true });
  const result = await f.run();
  assert.equal(result.state, "completed");
  assert.equal(result.usageStatus, "missing");
  assert.equal(Object.hasOwn(result, "usage"), false);
  assert.deepEqual(result.cumulativeUsage, { input: 20, output: 10 });
  const reading = adapter.read(JSON.stringify({ type: "native.result", ...result }), 0, "");
  assert.equal(Object.hasOwn(reading, "usage"), false);
  assert.equal(Object.hasOwn(reading, "sessionUsage"), false);
});

test("a mismatched returned turn cannot claim this run's completion or usage", async (t) => {
  const f = fixture(t, { wrongUsageTurn: true });
  const result = await f.run();
  assert.notEqual(result.state, "completed");
  assert.equal(result.usage, undefined);
});

test("multiple native roots require a trusted explicit selection and never choose the first root", async (t) => {
  const f = fixture(t);
  f.project.roots = ["/other-native-root", f.root];
  assert.equal((await f.run("1")).state, "needs-attention");
  assert.equal(f.calls.length, 0);
  f.config.managedCodex.projectRoots = { [f.key]: f.root };
  assert.equal((await f.run("2")).state, "completed");
  assert.equal(f.calls.find((c) => c[0] === "create")[1].cwd, f.root);
});

test("explicit roots must be absolute exact members, including for single-root projects", async (t) => {
  for (const selected of ["relative-root", "/not-a-native-project-root", "child", "normalized"]) {
    const f = fixture(t);
    f.config.managedCodex.projectRoots = {
      [f.key]:
        selected === "child"
          ? path.join(f.root, "child")
          : selected === "normalized"
            ? f.root + "/../project"
            : selected,
    };
    assert.equal((await f.run()).state, "needs-attention");
    assert.equal(f.calls.length, 0);
  }
});

test("only the executor's persisted turn delta is reported, never the final LLM request's last counter", async (t) => {
  const f = fixture(t, { partialUsage: true });
  const result = await f.run();
  assert.deepEqual(result.usage, { input: 20 });
  assert.equal(result.usageStatus, "partial");
  const reading = adapter.read(JSON.stringify({ type: "native.result", ...result }), 0, "");
  assert.deepEqual(reading.usage, { input: 20 });
  assert.equal(reading.usage.output, undefined);
});

const receiptResult = (text) => resultFrom(readMessage(text), {});
const brokenReceipt = '本轮已有产物\n```agent-autoloop\n{"later":[broken JSON]}\n```';

test("malformed model receipt degrades to a valid ask without another model invocation", async (t) => {
  const f = fixture(t, { finalText: brokenReceipt });
  const output = await f.run();
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
  const parsed = receiptResult(output.text);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.outcome, "done");
  assert.equal(parsed.result.ask.length, 1);
  assert.equal(parsed.result.later, undefined);
  assert.match(output.text, /已有产物|业务/);
  assert.ok(!output.text.includes("broken JSON"));
  const artifact = JSON.parse(readFileSync(output.artifact, "utf8"));
  assert.equal(artifact.originalText, brokenReceipt);
  assert.equal(typeof artifact.receiptError, "string");
  assert.ok(artifact.receiptError.length > 0);
  assert.deepEqual(output.usage, { input: 20, output: 10, cached: 4 });
  assert.equal(statSync(output.artifact).mode & 0o777, 0o600);
  assert.notEqual((await f.run("2")).state, "completed");
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
});

test("schema-invalid receipt is also quarantined even when its JSON parses", async (t) => {
  const raw = '已有结果\n```agent-autoloop\n{"later":[{"key":"review","at":3}]}\n```';
  const f = fixture(t, { finalText: raw });
  const output = await f.run();
  assert.equal(receiptResult(output.text).problem, undefined);
  assert.equal(receiptResult(output.text).result.ask.length, 1);
  assert.equal(JSON.parse(readFileSync(output.artifact, "utf8")).originalText, raw);
});

test("valid ask, notice and later receipts are unchanged and ordinary replay keeps original usage", async (t) => {
  const body = {
    ask: [{ key: "decision", title: "需要决定", text: "请选择", options: ["继续", "暂停"], about: "保留已有结果" }],
    notice: [{ title: "已有进展", text: "本轮检查完成" }],
    later: [{ key: "review", at: "2030-01-01T00:00:00+08:00", about: "核实结果" }],
  };
  const text = "本轮结束，事项待继续\n```agent-autoloop\n" + JSON.stringify(body) + "\n```";
  const f = fixture(t, { finalText: text });
  const first = await f.run(),
    replay = await f.run("1", { prompt: "普通业务重放" });
  assert.equal(first.text, text);
  assert.equal(replay.text, text);
  assert.equal(first.state, "completed");
  assert.equal(receiptResult(first.text).problem, undefined);
  assert.deepEqual(replay.usage, first.usage);
  assert.equal(first.originalText, undefined);
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
});

test("legacy bad result repair replays a safe ask without repeating usage or rewriting the old record", async (t) => {
  const f = fixture(t, { finalText: brokenReceipt });
  const first = await f.run();
  const database = path.join(path.dirname(first.artifact), "worker.db");
  const db = new DatabaseSync(database);
  const legacy = {
    state: "completed",
    text: brokenReceipt,
    session: first.session,
    usage: first.usage,
    cumulativeUsage: first.cumulativeUsage,
    artifact: first.artifact,
  };
  const encoded = JSON.stringify(legacy);
  db.prepare("UPDATE requests SET state='completed',result=? WHERE run_id='1'").run(encoded);
  db.exec("DELETE FROM receipt_blocks");
  db.close();
  const fixed = await f.run("1", { prompt: repairPrompt("invalid JSON") });
  const parsed = receiptResult(fixed.text);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.ask.length, 1);
  assert.equal(fixed.usage, undefined);
  assert.equal(fixed.cumulativeUsage, undefined);
  assert.equal(fixed.receiptRepairReplay, true);
  assert.equal(adapter.read(JSON.stringify({ type: "native.result", ...fixed }), 0, "").usage, undefined);
  const original = new DatabaseSync(database, { readOnly: true });
  assert.equal(original.prepare("SELECT result FROM requests WHERE run_id='1'").get().result, encoded);
  original.close();
  assert.equal(JSON.parse(readFileSync(fixed.artifact, "utf8")).originalText, brokenReceipt);
  assert.notEqual((await f.run("2")).state, "completed");
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
});

test("repair replay of an already valid result does not duplicate usage", async (t) => {
  const f = fixture(t);
  const first = await f.run();
  const repair = await f.run("1", { prompt: repairPrompt("legacy upstream repair") });
  assert.equal(repair.text, first.text);
  assert.equal(repair.usage, undefined);
  assert.equal(repair.cumulativeUsage, undefined);
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
});

test("a repair request without its original business record cannot launch a new model task", async (t) => {
  const f = fixture(t);
  const output = await f.run("1", { prompt: repairPrompt("orphaned repair") });
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 0);
  assert.equal(receiptResult(output.text).problem, undefined);
  assert.equal(receiptResult(output.text).result.ask.length, 1);
  assert.equal(output.errorCode, "MANAGED_RECEIPT_REPAIR_CONTEXT_MISSING");
});

test("repair wording embedded inside a normal upstream prompt does not alter ordinary business execution", async (t) => {
  const f = fixture(t);
  const output = await f.run("1", { prompt: "正常上游任务，以下是一段资料：" + repairPrompt("quoted diagnostic") });
  assert.equal(output.state, "completed");
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
  assert.deepEqual(output.usage, { input: 20, output: 10, cached: 4 });
});

test("later blocked runs reuse the same receipt-attention key", async (t) => {
  const f = fixture(t, { finalText: brokenReceipt });
  const first = await f.run("1"),
    later = await f.run("2");
  assert.equal(receiptResult(first.text).result.ask[0].key, receiptResult(later.text).result.ask[0].key);
  assert.equal(f.calls.filter((c) => c[0] === "continue").length, 1);
});
