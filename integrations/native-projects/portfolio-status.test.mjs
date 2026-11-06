// Running means a live claim or verified native execution; stored conversations and issue labels can mislead.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { subjectFor } from "./controls.mjs";
import { projectPortfolioStatus } from "./portfolio-status.mjs";

const project = (provider, nativeId, name) => ({
  provider,
  nativeId,
  host: "local",
  name,
  key: provider + ":local:" + nativeId,
});
const a = project("codex", "a", "活动工作台"),
  b = project("dsh", "b", "调研"),
  c = project("multica", "c", "培训");
const now = Date.now(),
  iso = (t) => new Date(t).toISOString(),
  rule = (p) => "native-project:" + subjectFor(p.key);
function fixture(t, { projects = [a], records = [], backends = {}, controls = [], missing = false } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "project-state-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const providers = Object.fromEntries(
    projects.map((p) => [p.provider, p.provider === "codex" ? { mode: "isolated-readonly-api" } : {}]),
  );
  if (!missing) {
    const db = new DatabaseSync(path.join(home, "hub.db"));
    db.exec("CREATE TABLE projections(collection TEXT,key TEXT,data TEXT NOT NULL,PRIMARY KEY(collection,key))");
    const put = db.prepare("INSERT INTO projections VALUES(?,?,?)");
    for (const [col, id, data] of records) put.run(col, String(id), JSON.stringify(data));
    db.close();
  }
  return {
    nativeConfig: { providers, loopHub: { configFile: path.join(home, "config.json") } },
    controls: { list: () => controls },
    catalog: { connectors: backends },
    overview: {
      complete: true,
      projects,
      providers: Object.keys(providers).map((provider) => ({ provider, status: "connected", complete: true })),
    },
    now,
  };
}
test("current work, owner decisions, timers and unknown leases are counted separately from enabled mode and notices", async (t) => {
  const f = fixture(t, {
    projects: [a, b, c],
    controls: [
      { projectKey: a.key, mode: "active" },
      { projectKey: c.key, mode: "active" },
    ],
    records: [
      ["runs", 1, { rule: rule(a), state: "claimed", seen_at: iso(now), summary: "NEVER_LEAK" }],
      ["runs", 2, { rule: rule(c), state: "claimed", seen_at: iso(now - 3600000) }],
      ["runs", 3, { rule: rule(b), state: "queued" }],
      ["cards", 5, { rule: rule(a), state: "open", kind: "ask", text: "SECRET_CONTENT" }],
      ["cards", 6, { rule: rule(b), state: "open", kind: "notice", text: "SECRET_CONTENT" }],
      ["timers", 8, { rule: rule(a), event_id: null, at: iso(now + 120000) }],
      ["timers", 9, { rule: rule(c), event_id: 3, at: iso(now - 600000) }],
      ["runs", 10, { rule: "other-rule", state: "claimed", seen_at: iso(now), summary: "OTHER" }],
    ],
  });
  const text = (await projectPortfolioStatus({ ...f, focus: "running" })).text;
  assert.match(text, /正在处理[^\n]*活动工作台/);
  assert.match(text, /排队[^\n]*调研/);
  assert.match(text, /待核实[^\n]*培训/);
  assert.doesNotMatch(text, /NEVER_LEAK|SECRET|other-rule|native-project/);
  assert.match((await projectPortfolioStatus({ ...f, focus: "decisions" })).text, /待你拍板[^\n]*活动工作台/);
  assert.doesNotMatch((await projectPortfolioStatus({ ...f, focus: "review" })).text, /培训/);
});
test("native scans use scoped metadata, report Multica execution rather than issue status, and keep stored Codex unknown", async (t) => {
  let reads = 0;
  const backend = {
    async listWork() {
      return {
        complete: true,
        items: [{ nativeId: "issue", projectId: "c", state: "unknown", nativeState: "in_progress" }],
      };
    },
    async readWork() {
      reads++;
      return { nativeId: "issue", projectId: "c", runs: [{ state: "completed" }] };
    },
  };
  const f = fixture(t, {
    projects: [a, b, c],
    backends: {
      codex: {
        async listWork() {
          assert.fail("isolated Codex cannot report live activity");
        },
      },
      multica: backend,
      dsh: {
        async listWork() {
          return {
            complete: true,
            items: [{ nativeId: "s", projectId: "b", agentAvailable: true, state: "running", running: true }],
          };
        },
      },
    },
  });
  const r = await projectPortfolioStatus(f);
  assert.equal(reads, 1);
  assert.match(r.text, /DeepSeek[^\n]*调研/);
  assert.match(r.text, /Codex[^\n]*未核实/);
  assert.doesNotMatch(r.text, /正在执行[^\n]*培训/);
  backend.readWork = async () => ({ nativeId: "issue", projectId: "not-c", runs: [{ state: "running" }] });
  assert.doesNotMatch((await projectPortfolioStatus(f)).text, /Multica[^\n]*正在执行[^\n]*培训/);
});
test("missing hub, partial source and single-project filtering never imply verified zero across projects", async (t) => {
  const f = fixture(t, { projects: [a, b], missing: true, controls: [{ projectKey: a.key, mode: "active" }] });
  const r = (await projectPortfolioStatus({ ...f, projectKey: a.key })).text;
  assert.match(r, /暂时无法核实/);
  assert.doesNotMatch(r, /没有正在|调研/);
  assert.match((await projectPortfolioStatus({ ...f, focus: "enabled" })).text, /活动工作台/);
});

test("an earlier or paused goal's open decision is not presented as a current choice; recent summaries omit technical details", async (t) => {
  const f = fixture(t, {
    projects: [a, b],
    controls: [
      { projectKey: a.key, mode: "active", goalStartEvent: "new-goal" },
      { projectKey: b.key, mode: "paused" },
    ],
    records: [
      ["events", 10, { key: "new-goal", subject: subjectFor(a.key), received_at: iso(now - 4000) }],
      ["cards", 2, { rule: rule(a), kind: "ask", state: "open", created_at: iso(now - 8000) }],
      ["cards", 3, { rule: rule(b), kind: "ask", state: "open", created_at: iso(now) }],
      ["timers", 4, { rule: rule(a), event_id: null, created_at: iso(now), at: iso(now + 10000) }],
      [
        "runs",
        7,
        { rule: rule(a), state: "done", finished_at: iso(now - 3000), summary: "项目简报：已整理第一版试用清单。" },
      ],
      [
        "runs",
        6,
        {
          rule: rule(b),
          state: "done",
          finished_at: iso(now - 4000),
          summary: "核对 /private/local/config.json 中内容",
        },
      ],
    ],
  });
  assert.match((await projectPortfolioStatus({ ...f, focus: "waiting" })).text, /没有待你拍板/);
  assert.match((await projectPortfolioStatus({ ...f, focus: "review" })).text, /已预约复查：活动工作台/);
  const recent = (await projectPortfolioStatus({ ...f, focus: "recent" })).text;
  assert.match(recent, /已整理第一版试用清单/);
  assert.doesNotMatch(recent, /private|config.json/);
});
test("a slow native provider cannot hold up an otherwise sound hub answer", async (t) => {
  const f = fixture(t, { projects: [b], backends: { dsh: { listWork: () => new Promise(() => {}) } } });
  const r = await projectPortfolioStatus({ ...f, timeoutMs: 10 });
  assert.match(r.text, /没有正在处理或排队/);
  assert.match(r.text, /部分原生状态/);
});
