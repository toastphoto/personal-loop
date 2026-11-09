import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopControls, ownedRules } from "./controls.mjs";

function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "native-controls-"));
  const file = path.join(dir, "modes.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { file, store: new LoopControls(file) };
}
test("every discovered project starts manual; enabling one never enables others", (t) => {
  const { store } = setup(t);
  assert.equal(store.get("codex:local:a").mode, "manual");
  store.set("codex:local:a", "active", { objective: "Finish a bounded task", maxSteps: 3, actor: "owner" });
  assert.equal(store.get("codex:local:a").mode, "active");
  assert.equal(store.get("dsh:local:b").mode, "manual");
});
test("pause survives a process restart and does not pretend the current native task stopped", (t) => {
  const { store, file } = setup(t);
  store.set("p", "active", { objective: "Task", maxSteps: 3, actor: "owner" });
  const paused = store.set("p", "paused", { actor: "owner" });
  assert.equal(new LoopControls(file).get("p").mode, "paused");
  assert.equal(paused.cancelRunning, false);
  assert.throws(() => store.assertActive("p"), /LOOP_NOT_ACTIVE/);
});
test("resume is explicit and a stale decision cannot undo a newer pause", (t) => {
  const { store } = setup(t);
  const first = store.set("p", "active", { objective: "Task", maxSteps: 3, actor: "owner" });
  store.set("p", "paused", { actor: "owner", expectedRevision: first.revision });
  assert.throws(
    () => store.set("p", "active", { actor: "owner", expectedRevision: first.revision }),
    /CONTROL_REVISION_CHANGED/,
  );
  assert.equal(store.set("p", "active", { actor: "owner", expectedRevision: 2 }).mode, "active");
});
test("enable requires a goal and rejects an invalid explicit step budget", (t) => {
  const { store } = setup(t);
  assert.throws(() => store.set("p", "active", { actor: "owner" }), /OBJECTIVE_REQUIRED/);
  assert.throws(
    () => store.set("p", "active", { actor: "owner", objective: "Task", maxSteps: 0 }),
    /INVALID_STEP_BUDGET/,
  );
});
test("rule generation includes active goals only, and different projects cannot wake one another", (t) => {
  const { store } = setup(t);
  store.set("a", "active", { actor: "owner", objective: "Task A", maxSteps: 3 });
  store.set("b", "active", { actor: "owner", objective: "Task B", maxSteps: 3 });
  store.set("c", "paused", { actor: "owner" });
  const rules = ownedRules(store.list(), { source: "local", agent: "supervisor", cwd: "/safe/control" });
  assert.equal(rules.length, 2);
  assert.notEqual(rules[0].when.types[0], rules[1].when.types[0]);
  store.set("a", "paused", { actor: "owner" });
  assert.equal(ownedRules(store.list(), { source: "local", agent: "supervisor", cwd: "/safe/control" }).length, 1);
});

test("paused or manual observer returns before opening any native connector", (t) => {
  const { file } = setup(t);
  const configFile = path.join(path.dirname(file), "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      controlsFile: file,
      providers: { codex: { command: "/nonexistent-native-command", mode: "isolated-readonly-api" } },
      goals: [{ id: "goal", projectKey: "codex:local:p", outputDirectory: path.dirname(file) }],
    }),
  );
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [cli, "--config", configFile, "observe", "goal"], { encoding: "utf8" });
  assert.equal(JSON.parse(out).reason, "LOOP_NOT_ACTIVE");
});

test("a replayed command returns its receipt without undoing a later pause", (t) => {
  const { store } = setup(t);
  const first = store.set("p", "active", {
    objective: "Task",
    maxSteps: 3,
    actor: "owner",
    requestId: "message-1",
    expectedRevision: 0,
  });
  store.set("p", "paused", { actor: "owner", requestId: "message-2", expectedRevision: 1 });
  const replay = store.set("p", "active", {
    objective: "Task",
    maxSteps: 3,
    actor: "owner",
    requestId: "message-1",
    expectedRevision: 2,
  });
  assert.equal(replay.revision, first.revision);
  assert.equal(store.get("p").mode, "paused");
  assert.equal(store.get("p").revision, 2);
  assert.throws(
    () =>
      store.set("p", "active", { objective: "Different task", maxSteps: 3, actor: "owner", requestId: "message-1" }),
    /CONTROL_REQUEST_ID_REUSED/,
  );
});

test("a process killed while saving cannot leave pause permanently locked", (t) => {
  const { store, file } = setup(t);
  store.set("p", "active", { objective: "Task", maxSteps: 3, actor: "owner" });
  const source = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; fs.renameSync=()=>process.kill(process.pid,'SIGKILL'); syncBuiltinESMExports(); const {LoopControls}=await import(${JSON.stringify(new URL("./controls.mjs", import.meta.url).href)}); new LoopControls(${JSON.stringify(file)}).set('p','paused',{actor:'owner'});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source]);
  assert.equal(child.signal, "SIGKILL");
  assert.equal(store.get("p").mode, "active");
  assert.equal(store.set("p", "paused", { actor: "owner" }).mode, "paused");
});

test("a verified project display name is retained for offline pause lookup", (t) => {
  const { store } = setup(t);
  store.set("codex:local:p", "paused", { actor: "owner", projectName: "Example Project" });
  assert.equal(store.get("codex:local:p").projectName, "Example Project");
});

test("new goals explicitly default to completion-driven work while resume retains the existing limit", (t) => {
  const { store, file } = setup(t);
  const first = store.set("p", "active", {
    actor: "owner",
    objective: "Finish the selected goal",
    requestId: "new-goal",
  });
  assert.equal(first.maxSteps, null);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).projects.p.maxSteps, null);
  store.set("p", "paused", { actor: "owner" });
  assert.equal(store.set("p", "active", { actor: "owner" }).maxSteps, null);
  store.set("p", "manual", { actor: "owner" });
  store.set("p", "active", { actor: "owner", objective: "Older bounded goal", maxSteps: 5 });
  store.set("p", "paused", { actor: "owner" });
  assert.equal(store.set("p", "active", { actor: "owner" }).maxSteps, 5);
  store.set("p", "manual", { actor: "owner" });
  assert.equal(store.set("p", "active", { actor: "owner", objective: "Another new goal" }).maxSteps, null);
});

test("omitting the limit while pausing preserves it, while explicit null is a distinct request", (t) => {
  const { store } = setup(t);
  store.set("p", "active", { actor: "owner", objective: "Existing goal", maxSteps: 5 });
  const paused = store.set("p", "paused", { actor: "owner", requestId: "pause-one" });
  assert.equal(paused.maxSteps, 5);
  assert.throws(() => store.set("p", "paused", { actor: "owner", requestId: "pause-one", maxSteps: null }), {
    code: "CONTROL_REQUEST_ID_REUSED",
  });
  assert.equal(store.set("p", "paused", { actor: "owner", requestId: "pause-one" }).revision, paused.revision);
});
