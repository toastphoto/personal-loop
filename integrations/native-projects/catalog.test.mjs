import test from "node:test";
import assert from "node:assert/strict";
import { ProjectCatalog, projectKey } from "./catalog.mjs";

const project = (nativeId, name = "Same name") => ({ nativeId, name, roots: [], capabilities: { read: true } });
function connector(projects, more = {}) {
  return { listProjects: async () => ({ projects, complete: true }), ...more };
}
test("identical titles across systems keep independent native identities", async () => {
  const catalog = new ProjectCatalog({ codex: connector([project("1")]), multica: connector([project("1")]) });
  const view = await catalog.refresh();
  assert.equal(new Set(view.projects.map((p) => p.key)).size, 2);
  assert.equal(view.complete, true);
});
test("unavailable provider remains visible and does not erase connected projects", async () => {
  const catalog = new ProjectCatalog({
    codex: connector([project("1")]),
    dsh: {
      listProjects: async () => {
        throw Object.assign(new Error("private material"), { code: "GATEWAY_NOT_CONFIGURED" });
      },
    },
  });
  const view = await catalog.refresh();
  assert.equal(view.projects.length, 1);
  assert.equal(view.complete, false);
  assert.equal(view.providers[1].status, "unavailable");
  assert.ok(!JSON.stringify(view).includes("private material"));
});
test("refresh drops disappeared entries instead of serving stale authority", async () => {
  let values = [project("1")];
  const catalog = new ProjectCatalog({ codex: { listProjects: async () => ({ projects: values, complete: true }) } });
  await catalog.refresh();
  values = [];
  await catalog.refresh();
  assert.throws(() => catalog.resolve(projectKey("codex", "local", "1")), /PROJECT_NOT_AVAILABLE/);
});
test("a native ID must not escape its provider or project", async () => {
  const catalog = new ProjectCatalog({
    codex: connector([project("one")], { readWork: async () => ({ nativeId: "task", projectId: "another" }) }),
  });
  await catalog.refresh();
  await assert.rejects(catalog.readWork(projectKey("codex", "local", "one"), "task"), /PROJECT_MISMATCH/);
});
test("partial pagination is reported and cannot imply a complete catalog", async () => {
  const catalog = new ProjectCatalog({
    codex: { listProjects: async () => ({ projects: [project("one")], complete: false }) },
  });
  assert.equal((await catalog.refresh()).complete, false);
});
test("task list preserves native and normalized state and rejects foreign project", async () => {
  let projectId = "one";
  const catalog = new ProjectCatalog({
    codex: connector([project("one")], {
      listWork: async () => ({
        items: [{ nativeId: "task", projectId, title: "T", state: "idle", nativeState: "notLoaded" }],
        complete: true,
      }),
    }),
  });
  await catalog.refresh();
  const key = projectKey("codex", "local", "one");
  assert.equal((await catalog.listWork(key)).items[0].nativeState, "notLoaded");
  projectId = "other";
  await assert.rejects(catalog.listWork(key), /PROJECT_MISMATCH/);
});
test("malformed or duplicate project identities fail the provider visibly", async () => {
  for (const projects of [[{ name: "missing id" }], [project("one"), project("one")]]) {
    const view = await new ProjectCatalog({ codex: connector(projects) }).refresh();
    assert.equal(view.providers[0].status, "unavailable");
    assert.equal(view.projects.length, 0);
  }
});
