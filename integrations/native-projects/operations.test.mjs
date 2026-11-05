import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Operations } from "./operations.mjs";
import { LoopControls } from "./controls.mjs";
function setup(t, grants = [], method = async () => ({ accepted: true, executionId: "turn-1" })) {
  const folder = mkdtempSync(path.join(tmpdir(), "native-ops-"));
  let calls = 0;
  const backend = {
    continueWork: async (args) => {
      calls++;
      return method(args);
    },
    cancelWork: async (args) => {
      calls++;
      return method(args);
    },
  };
  const catalog = {
    resolve: () => ({ project: { nativeId: "p" }, backend }),
    readWork: async () => ({ nativeId: "t", projectId: "p", state: "idle" }),
  };
  const controls = new LoopControls(path.join(folder, "controls.json"));
  if (grants.length)
    controls.set("key", "active", { objective: "Authorized test task", maxSteps: 3, actor: "test-owner" });
  const ops = new Operations(path.join(folder, "operations.db"), catalog, grants, controls);
  t.after(() => {
    ops.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return { ops, controls, catalog, calls: () => calls };
}
const grant = () => ({
  projectKey: "key",
  actions: ["continue", "cancel"],
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  maxActions: 2,
});
const request = () => ({ operationId: "request-1", projectKey: "key", nativeId: "t", text: "Do bounded task" });
test("no configured project grant means no native mutation", async (t) => {
  const { ops, calls } = setup(t);
  await assert.rejects(ops.run("continue", request()), /PROJECT_ACTION_NOT_AUTHORIZED/);
  assert.equal(calls(), 0);
});
test("accepted operation is replayed once and never claimed as completed", async (t) => {
  const { ops, calls } = setup(t, [grant()]);
  const first = await ops.run("continue", request());
  assert.equal(first.state, "accepted");
  assert.deepEqual(await ops.run("continue", request()), first);
  assert.equal(calls(), 1);
  await assert.rejects(ops.run("continue", { ...request(), text: "Changed task" }), /OPERATION_ID_REUSED/);
});
test("uncertain remote result is retained; retry cannot launch another execution", async (t) => {
  const { ops, calls } = setup(t, [grant()], async () => {
    throw new Error("connection lost after dispatch");
  });
  const result = await ops.run("continue", request());
  assert.equal(result.state, "unknown");
  assert.deepEqual(await ops.run("continue", request()), result);
  assert.equal(calls(), 1);
});
test("expired grant or action budget blocks before native call", async (t) => {
  const g = grant();
  g.maxActions = 1;
  const { ops, calls } = setup(t, [g]);
  await ops.run("continue", request());
  await assert.rejects(ops.run("continue", { ...request(), operationId: "request-2" }), /ACTION_BUDGET_EXHAUSTED/);
  g.expiresAt = "2000-01-01T00:00:00Z";
  await assert.rejects(ops.run("cancel", { ...request(), operationId: "request-3" }), /PROJECT_ACTION_NOT_AUTHORIZED/);
  assert.equal(calls(), 1);
});

test("pause blocks a fresh automatic continuation before dispatch", async (t) => {
  const { ops, controls, calls } = setup(t, [grant()]);
  controls.set("key", "paused", { actor: "owner" });
  await assert.rejects(ops.run("continue", request()), /LOOP_NOT_ACTIVE/);
  assert.equal(calls(), 0);
});
test("pause during status lookup prevents the following native mutation", async (t) => {
  const { ops, controls, catalog, calls } = setup(t, [grant()]);
  catalog.readWork = async () => {
    controls.set("key", "paused", { actor: "owner" });
    return {};
  };
  const result = await ops.run("continue", request());
  assert.equal(result.state, "rejected");
  assert.equal(calls(), 0);
});
test("comment accepted but execution rejected is never promoted to accepted", async (t) => {
  const { ops } = setup(t, [grant()], async () => ({ accepted: false, commentPosted: true }));
  assert.equal((await ops.run("continue", request())).state, "rejected");
});
