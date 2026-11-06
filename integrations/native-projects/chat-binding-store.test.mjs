// The picker can route an owner's future goals. A stale card, partial native directory or concurrent start must never retarget them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopControls } from "./controls.mjs";
import { readConfig } from "./factory.mjs";
import { ChatBindingStore } from "./chat-binding-store.mjs";
const one = "11111111-1111-4111-8111-111111111111",
  two = "22222222-2222-4222-8222-222222222222",
  three = "33333333-3333-4333-8333-333333333333";
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "chat-binding-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "codex:local:pj",
    root = dir,
    file = path.join(dir, "native.json");
  const controls = new LoopControls(path.join(dir, "control.json"));
  const config = {
    version: 1,
    providers: { codex: {} },
    controlsFile: controls.file,
    managedCodex: {
      enabled: true,
      coordinatorProjectKeys: [key],
      projectRoots: { [key]: root },
      boundChats: { [key]: { projectId: "pj", root, threadId: one } },
    },
  };
  writeFileSync(file, JSON.stringify(config));
  const row = (id, more = {}) => ({
    id,
    name: "同名原聊天",
    updatedAt: 1800000001,
    createdAt: 1700000000,
    cwd: root,
    projectId: "pj",
    ephemeral: false,
    source: "vscode",
    originator: "Codex Desktop",
    agentNickname: null,
    agentRole: null,
    threadSource: null,
    parentThreadId: null,
    ...more,
  });
  let rows = [
    row(one, { projectId: null }),
    row(two, { updatedAt: 1801000000 }),
    row(three, { originator: "personal_loop_owned_executor" }),
  ];
  let listing = true,
    onList;
  let projects = [{ nativeId: "pj", roots: [root] }];
  const backend = {
    listProjects: async () => ({ complete: listing, projects }),
    pages: async (method, params) => {
      assert.equal(method, "thread/list");
      assert.deepEqual(params.cwd, [root]);
      assert.equal(params.archived, false);
      assert.equal(params.useStateDbOnly, true);
      onList?.();
      return structuredClone(rows);
    },
    rawWork: async (id) => structuredClone(rows.find((x) => x.id === id)),
  };
  const catalog = { connectors: { codex: backend } };
  const store = new ChatBindingStore({ configFile: file, controls, catalog });
  const args = () => ({
    projectKey: key,
    threadId: two,
    expectedTitle: "同名原聊天",
    expectedRevision: 0,
    expectedControlRevision: 0,
    requestId: "choice1",
    actor: "owner",
    beforeMutation: () => {},
  });
  return {
    key,
    root,
    file,
    controls,
    config,
    store,
    row,
    args,
    setRows: (v) => (rows = v),
    setProjects: (v) => (projects = v),
    setComplete: (v) => (listing = v),
    onList: (fn) => (onList = fn),
  };
}
test("chooses exact thread among duplicate titles; durable hot binding is read by long-lived and restarted clients", async (t) => {
  const f = fixture(t),
    hot = readConfig(f.file),
    before = readFileSync(f.file, "utf8");
  const l = await f.store.list(f.key);
  assert.equal(l.current.title, "同名原聊天");
  assert.deepEqual(
    l.items.map((x) => x.threadId),
    [two, one],
  );
  assert.equal(l.canChange, true);
  const picked = await f.store.select(f.args());
  assert.equal(picked.threadId, two);
  assert.equal(hot.managedCodex.boundChats[f.key].threadId, two);
  assert.equal(readConfig(f.file).managedCodex.boundChats[f.key].threadId, two);
  assert.equal(f.store.current(f.key).revision, 1);
  assert.equal(f.controls.get(f.key).mode, "manual");
  assert.equal(f.controls.get(f.key).revision, 1);
  assert.equal(readFileSync(f.file, "utf8"), before);
  await f.store.select(f.args());
  assert.equal(f.store.current(f.key).revision, 1);
  await assert.rejects(f.store.select({ ...f.args(), threadId: one, requestId: "different" }));
  assert.equal(f.store.current(f.key).threadId, two);
});
test("rejects internal/foreign/archived/temporary candidates and partial inventories", async (t) => {
  const f = fixture(t);
  for (const row of [
    f.row(two, { cwd: f.root + "/other" }),
    f.row(two, { projectId: "someone-else" }),
    f.row(two, { archived: true }),
    f.row(two, { ephemeral: true }),
    f.row(two, { source: { subAgent: {} } }),
    f.row(two, { originator: "personal_loop_owned_executor" }),
    f.row(two, { threadSource: "personal-loop" }),
    f.row(two, { parentThreadId: one }),
  ]) {
    f.setRows([f.row(one), row]);
    assert.deepEqual(
      (await f.store.list(f.key)).items.map((x) => x.threadId),
      [one],
    );
    await assert.rejects(f.store.select(f.args()));
  }
  f.setComplete(false);
  assert.equal((await f.store.list(f.key)).canChange, false);
  await assert.rejects(f.store.select(f.args()));
  assert.equal(f.controls.get(f.key).revision, 0);
});
test("selection cannot race an active goal, pause, revoked group check, rename or outdated revision", async (t) => {
  const f = fixture(t);
  f.onList(() => {
    f.controls.set(f.key, "active", { actor: "user", objective: "保留", maxSteps: 3 });
    f.onList(null);
  });
  await assert.rejects(f.store.select(f.args()));
  assert.equal(f.store.current(f.key).threadId, one);
  assert.equal(f.controls.get(f.key).objective, "保留");
  const p = f.controls.set(f.key, "paused", { actor: "user" });
  await assert.rejects(f.store.select({ ...f.args(), expectedControlRevision: p.revision }));
  const m = f.controls.set(f.key, "manual", { actor: "user" });
  const args = { ...f.args(), expectedControlRevision: m.revision };
  await assert.rejects(
    f.store.select({
      ...args,
      beforeMutation: () => {
        throw new Error("revoked");
      },
    }),
  );
  await assert.rejects(f.store.select({ ...args, expectedTitle: "renamed" }));
  assert.equal(f.store.current(f.key).threadId, one);
});

test("unassigned chats at a root claimed by multiple projects are not proposed as this project's conversations", async (t) => {
  const f = fixture(t);
  f.setProjects([
    { nativeId: "pj", roots: [f.root] },
    { nativeId: "other", roots: [f.root] },
  ]);
  assert.deepEqual(
    (await f.store.list(f.key)).items.map((i) => i.threadId),
    [two],
  );
  await assert.rejects(f.store.select({ ...f.args(), threadId: one }));
});
