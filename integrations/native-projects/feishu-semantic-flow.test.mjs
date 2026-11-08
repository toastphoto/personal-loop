// Ordinary phrasing must reach real status lookup; classifying a question may never start a task or create two replies.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { ProjectCardController } from "./feishu-card-control.mjs";
import { FeishuLoopRelay } from "./feishu-relay.mjs";
import { RelayQueue } from "./relay-queue.mjs";
import { readSemanticRoute } from "./semantic-route-store.mjs";

function fixture(t, classify) {
  const dir = mkdtempSync(path.join(tmpdir(), "query-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = {
    profile: "bot",
    chatId: "oc_g",
    allowedSenderIds: ["ou_owner"],
    queuePath: path.join(dir, "in"),
    naturalRoutingFile: path.join(dir, "routing.json"),
  };
  const routing = {
    ...cfg,
    enabled: true,
    botMentionIds: ["ou_bot"],
    projectNames: [],
    semanticQueries: {
      enabled: true,
      enabledAt: new Date(Date.now() - 1000).toISOString(),
      decisionDir: realpathSync(dir),
    },
  };
  writeFileSync(cfg.queuePath, "");
  writeFileSync(cfg.naturalRoutingFile, JSON.stringify(routing));
  const queue = new RelayQueue(path.join(dir, "relay.db"));
  t.after(() => queue.close());
  const asked = [],
    sent = [],
    queries = [];
  const cards = new ProjectCardController(cfg, {
    controls: { list: () => [], get: () => ({ mode: "manual", revision: 0 }) },
    catalog: { refresh: async () => ({ complete: true, projects: [], providers: [] }) },
    store: { context: () => null },
    semanticQuery: async (q, opts) => {
      asked.push(q);
      return classify(q, opts);
    },
    portfolio: async (opts) => {
      queries.push(opts);
      return { ok: true, action: "portfolio-status", text: "当前没有大肥鱼接手的任务。" };
    },
  });
  const relay = new FeishuLoopRelay(cfg, {
    queue,
    cards,
    reply: async (item) => {
      sent.push(item.response);
      return "om_sent";
    },
  });
  async function push(q, id = "om_q") {
    const event = {
      message_id: id,
      create_time: String(Date.now()),
      chat_id: cfg.chatId,
      sender_id: "ou_owner",
      sender_type: "user",
      message_type: "text",
      mentions: [{ id: "ou_bot", name: "大肥鱼" }],
      content: "@大肥鱼 " + q,
    };
    appendFileSync(cfg.queuePath, JSON.stringify(event) + "\n");
    await relay.tick();
    return event;
  }
  return { relay, queue, routing, cfg, asked, sent, queries, push };
}
test("the actual mistaken lookup and a keyword-free paraphrase query the portfolio, not a project called the sentence", async (t) => {
  const f = fixture(t, () => ({ kind: "query", action: "portfolio", filter: "running" }));
  await f.relay.tick();
  for (const [i, q] of ["看一下我有哪些项目在跑", "手头有啥在动"].entries()) {
    const event = await f.push(q, "om_query" + i);
    await f.relay.drainNatural();
    await f.relay.tick();
    assert.equal(f.queue.get(event.message_id).state, "replied");
    assert.equal(f.queries[i].focus, "running");
    if (i === 1) assert.equal(readSemanticRoute(event, f.routing), "loop");
  }
  assert.deepEqual(f.asked, ["看一下我有哪些项目在跑", "手头有啥在动"]);
  assert.equal(f.sent.length, 2);
});
test("external work releases only legacy-eligible input and sends no second reply", async (t) => {
  const f = fixture(t, () => ({ kind: "external", action: null }));
  await f.relay.tick();
  const e = await f.push("帮我制作展会海报。");
  await f.relay.drainNatural();
  await f.relay.tick();
  assert.equal(readSemanticRoute(e, f.routing), "legacy");
  assert.equal(f.queue.get(e.message_id).state, "ignored");
  assert.equal(f.sent.length, 0);
});
test("an uncertain model result stays a clarification; no issue or project mutation", async (t) => {
  const f = fixture(t, () => ({ kind: "unavailable", action: null, text: "暂时没能确认你的问题。" }));
  await f.relay.tick();
  const e = await f.push("手头还有啥要我过目");
  await f.relay.drainNatural();
  await f.relay.tick();
  assert.equal(readSemanticRoute(e, f.routing), "loop");
  assert.deepEqual(f.sent, ["暂时没能确认你的问题。"]);
});

test("a slow question does not hold up another answer or start the same question twice", async (t) => {
  let release, firstStarted;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const f = fixture(t, async (q) => {
    if (q === "手头有啥在动") {
      firstStarted();
      await gate;
    }
    return { kind: "query", action: "portfolio", filter: "running" };
  });
  await f.relay.tick();
  await f.push("手头有啥在动", "om_first");
  await started;
  await f.push("还有谁等我点头", "om_second");
  for (let i = 0; i < 10 && f.queue.get("om_second").state !== "replied"; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await f.relay.tick();
  }
  assert.equal(f.queue.get("om_first").state, "pending");
  assert.equal(f.queue.get("om_second").state, "replied");
  release();
  await f.relay.drainNatural();
  await f.relay.tick();
  assert.equal(f.asked.length, 2);
});

test("an opted original project can continue without a goal card; active continuation never duplicates it", async (t) => {
  const { LoopControls } = await import("./controls.mjs");
  const { projectAlias } = await import("./feishu-commands.mjs");
  const f = fixture(t, () => ({ kind: "query", action: "projects" }));
  const dir = path.dirname(f.cfg.queuePath),
    file = path.join(dir, "native.json"),
    controls = new LoopControls(path.join(dir, "controls.json"));
  const project = {
    key: "codex:local:p",
    provider: "codex",
    host: "local",
    nativeId: "p",
    name: "公司项目",
    capabilities: { queueBound: true },
  };
  const binding = { threadId: "original", projectId: "p", root: "/project" };
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      providers: {},
      controlsFile: controls.file,
      managedCodex: { boundChats: { [project.key]: binding } },
    }),
  );
  f.cfg.nativeConfigFile = file;
  f.relay.config.nativeConfigFile = file;
  f.relay.controls = controls;
  f.relay.catalog = { readProvider: async () => ({ complete: true, projects: [project] }) };
  f.relay.cards.enabled = () => true;
  f.relay.canCoordinate = (k, id) => k === project.key && id === "original";
  f.relay.readiness = async () => ({ ready: true, rulesReady: true });
  let syncs = 0;
  f.relay.syncRules = async () => {
    syncs++;
    return { ok: true };
  };
  const routing = { directGoalProjects: [{ projectKey: project.key, enabledAt: new Date(0).toISOString() }] };
  const item = {
    requestId: "explicit-continue",
    event: {
      sender_id: "ou_owner",
      create_time: String(Date.now()),
      content: "@大肥鱼 公司项目没有重大选择就继续",
      mentions: [{ name: "大肥鱼", id: "ou_bot" }],
    },
  };
  const result = await f.relay.continueProject(item, projectAlias(project), () => routing);
  assert.equal(result.ok, true);
  assert.equal(controls.get(project.key).mode, "active");
  assert.equal(controls.get(project.key).expectedThreadId, "original");
  assert.equal(syncs, 1);
  await f.relay.continueProject(item, projectAlias(project), () => routing);
  assert.equal(syncs, 1);
  await assert.rejects(
    f.relay.continueProject({ ...item, requestId: "unapproved" }, projectAlias(project), () => ({
      directGoalProjects: [],
    })),
    { code: "DIRECT_GOAL_SCOPE_CHANGED" },
  );
});
