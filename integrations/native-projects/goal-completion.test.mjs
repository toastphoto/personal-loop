// Never complete a new owner goal from an old planner finish, an uncommitted run or an unresolved decision.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LoopControls, subjectFor } from "./controls.mjs";
import { settleCompletedGoals } from "./goal-completion.mjs";
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function fixture(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "goal-completion-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "codex:local:fixture",
    projectId = "fixture",
    threadId = "bound-original",
    root = path.join(dir, "project");
  mkdirSync(root);
  const stateDir = path.join(dir, "private");
  mkdirSync(stateDir, { mode: 0o700 });
  const nativeConfig = {
    managedCodex: {
      enabled: true,
      stateDir,
      coordinatorProjectKeys: [key],
      projectRoots: { [key]: root },
      boundChats: { [key]: { projectId, threadId, root } },
    },
    loopHub: { configFile: path.join(dir, "hub.json") },
  };
  const configFile = path.join(dir, "native.json");
  writeFileSync(configFile, JSON.stringify(nativeConfig), { mode: 0o600 });
  const controls = new LoopControls(path.join(dir, "controls.json"));
  const control = controls.set(key, "active", {
    actor: "owner",
    objective: "验收两个页面",
    requestId: "start",
    maxSteps: null,
  });
  const goalId = hash([key, projectId, root, control.objective, control.goalRevision]);
  const ledgerDir = path.join(stateDir, hash(key));
  mkdirSync(ledgerDir, { mode: 0o700 });
  const workerFile = path.join(ledgerDir, "worker.db");
  const ledger = new DatabaseSync(workerFile);
  chmodSync(workerFile, 0o600);
  ledger.exec(
    "CREATE TABLE requests(run_id TEXT PRIMARY KEY,goal_id TEXT,state TEXT,result TEXT); CREATE TABLE bound_routes(goal_id TEXT PRIMARY KEY,binding TEXT)",
  );
  ledger.prepare("INSERT INTO bound_routes VALUES(?,?)").run(goalId, JSON.stringify([threadId, projectId, root]));
  const finish = { state: "completed", coordinator: { action: "finish", runId: "9" } };
  ledger.prepare("INSERT INTO requests VALUES(?,?,?,?)").run("9", goalId, "completed", JSON.stringify(finish));
  const hubFile = path.join(dir, "hub.db"),
    hub = new DatabaseSync(hubFile);
  chmodSync(hubFile, 0o600);
  hub.exec("CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key))");
  const put = (collection, id, data) =>
    hub.prepare("INSERT OR REPLACE INTO projections VALUES(?,?,?)").run(collection, String(id), JSON.stringify(data));
  const rule = "native-project:" + subjectFor(key),
    agent = "native-managed-" + subjectFor(key);
  const run = {
    id: 9,
    rule,
    grp: rule,
    agent,
    lane: "",
    state: "done",
    attempts: 0,
    finished_at: new Date().toISOString(),
    last_result: "accepted-result",
    rules_version: "r1",
  };
  put("runs", 9, run);
  put("config", "r1", {
    value: {
      agents: {
        [agent]: {
          use: "native-managed",
          command: [configFile, key],
          name: `原生项目 ${subjectFor(key).slice(0, 10)} · 目标 ${control.goalRevision} · 控制 ${control.revision}`,
        },
      },
    },
  });
  put("cards", 30, {
    kind: "notice",
    state: "open",
    rule,
    run_id: 9,
    key: `thread:${rule}::goal-complete-${goalId.slice(0, 40)}`,
  });
  t.after(() => {
    ledger.close();
    hub.close();
  });
  let failSync = false;
  const calls = [];
  const runtime = {
    async sync(input) {
      calls.push(input);
      if (failSync) throw Error("offline");
      return { ok: true };
    },
  };
  const settle = () => settleCompletedGoals({ nativeConfig, configFile, controls, runtime });
  return {
    key,
    controls,
    control,
    goalId,
    ledger,
    hub,
    workerFile,
    nativeConfig,
    configFile,
    put,
    run,
    rule,
    agent,
    calls,
    settle,
    failSync: (v) => (failSync = v),
  };
}
test("an acknowledged finish closes only that continuous generation and preserves its objective", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.settle(), [
    { projectKey: f.key, goalRevision: f.control.goalRevision, status: "completed" },
  ]);
  assert.equal(f.controls.get(f.key).mode, "manual");
  assert.equal(f.controls.get(f.key).objective, f.control.objective);
  assert.equal(f.calls[0].action, "manual");
  const once = f.controls.get(f.key).revision;
  await f.settle();
  assert.equal(f.controls.get(f.key).revision, once);
  assert.equal(f.calls[0].requestId, f.calls[1].requestId);
});
test("provisional finishes, waiting work and unresolved human decisions cannot close the goal", async (t) => {
  for (const kind of [
    "claimed-finish",
    "no-notice",
    "queued",
    "claimed",
    "unknown",
    "timer",
    "open-ask",
    "decided-ask",
    "wrong-attempt",
    "wrong-binding",
    "newer-intent",
  ]) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      if (kind === "claimed-finish") f.put("runs", 9, { ...f.run, state: "claimed" });
      else if (kind === "no-notice") f.hub.prepare("DELETE FROM projections WHERE collection='cards'").run();
      else if (["queued", "claimed", "unknown"].includes(kind)) f.put("runs", 10, { ...f.run, id: 10, state: kind });
      else if (kind === "timer") f.put("timers", 3, { rule: f.rule, event_id: null });
      else if (kind.endsWith("-ask")) f.put("cards", 31, { rule: f.rule, kind: "ask", state: kind.split("-")[0] });
      else if (kind === "wrong-attempt") f.put("runs", 9, { ...f.run, attempts: 1 });
      else if (kind === "wrong-binding") f.ledger.prepare("UPDATE bound_routes SET binding='[]'").run();
      else f.ledger.prepare("INSERT INTO requests VALUES(?,?,?,NULL)").run("10", f.goalId, "intent");
      assert.deepEqual(await f.settle(), []);
      assert.equal(f.controls.get(f.key).mode, "active");
      assert.equal(f.calls.length, 0);
    });
  }
});
test("a new owner goal racing the final control write cannot be overwritten", async (t) => {
  const f = fixture(t),
    original = f.controls.set.bind(f.controls);
  f.controls.set = (key, mode, options) => {
    original(key, "active", { actor: "owner", objective: "新的目标", requestId: "new-goal" });
    return original(key, mode, options);
  };
  assert.deepEqual(await f.settle(), []);
  assert.equal(f.controls.get(f.key).mode, "active");
  assert.equal(f.controls.get(f.key).objective, "新的目标");
  assert.equal(f.calls.length, 0);
});
test("sync failure leaves manual control and can resume cleanup without a second transition", async (t) => {
  const f = fixture(t);
  f.failSync(true);
  assert.equal((await f.settle())[0].status, "sync-pending");
  const revision = f.controls.get(f.key).revision;
  assert.equal(f.controls.get(f.key).mode, "manual");
  f.failSync(false);
  assert.equal((await f.settle())[0].status, "completed");
  assert.equal(f.controls.get(f.key).revision, revision);
});
test("new generations, changed bindings, unsafe ledger paths and legacy budgets remain untouched", async (t) => {
  for (const kind of ["new-goal", "config-change", "symlink", "public-file", "numeric-budget"]) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      if (kind === "new-goal")
        f.controls.set(f.key, "active", { actor: "owner", objective: "新一代工作", requestId: "new-goal" });
      else if (kind === "config-change")
        writeFileSync(
          f.configFile,
          JSON.stringify({ ...f.nativeConfig, managedCodex: { ...f.nativeConfig.managedCodex, enabled: false } }),
        );
      else if (kind === "symlink") {
        renameSync(f.workerFile, f.workerFile + ".real");
        symlinkSync(f.workerFile + ".real", f.workerFile);
      } else if (kind === "public-file") chmodSync(f.workerFile, 0o644);
      else f.controls.set(f.key, "active", { actor: "owner", maxSteps: 3, requestId: "numeric-budget" });
      assert.deepEqual(await f.settle(), []);
      assert.equal(f.controls.get(f.key).mode, "active");
    });
  }
});
