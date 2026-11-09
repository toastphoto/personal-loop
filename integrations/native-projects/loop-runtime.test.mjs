// Prevent inert enables, lost-ack duplicate jobs, cross-project rule edits, and stale enables undoing pause.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { digest } from "../../kernel/credentials.ts";
import { NativeLoopRuntime } from "./loop-runtime.mjs";
import { LoopControls, subjectFor } from "./controls.mjs";
import { parseRules } from "../../protocol/rules.ts";

function fixture(t, settings = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "native-loop-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controlCwd = path.join(dir, "control"),
    root = path.join(dir, "project");
  mkdirSync(controlCwd);
  mkdirSync(root);
  const configFile = path.join(dir, "native.json"),
    rulesFile = path.join(dir, "rules.json"),
    hubFile = path.join(dir, "hub.json");
  const key = "codex:local:project-one",
    otherKey = "codex:local:project-two";
  const rules = {
    timezone: "Asia/Shanghai",
    sources: { native: { name: "原生项目" }, unrelated: { name: "其他来源" } },
    agents: {
      unrelated: { name: "Existing", use: "command", command: ["true"], worker: "test-worker", access: "read" },
    },
    rules: [
      { name: "untouched", to: "unrelated", cwd: controlCwd, when: { source: "unrelated", types: ["existing.event"] } },
    ],
  };
  const saveRules = (value) => writeFileSync(rulesFile, JSON.stringify(value), { mode: 0o600 });
  saveRules(rules);
  writeFileSync(
    hubFile,
    JSON.stringify({
      url: "http://127.0.0.1:4567",
      owner: "fixture-owner",
      source: { name: "native", key: "fixture-source" },
    }),
    { mode: 0o600 },
  );
  const nativeConfig = {
    version: 1,
    providers: {},
    controlsFile: path.join(controlCwd, "modes.json"),
    managedCodex: { enabled: true, stateDir: controlCwd, projectRoots: { [key]: root, [otherKey]: root } },
    loopHub: { configFile: hubFile, rulesFile, workerName: "test-worker", controlCwd },
  };
  const saveConfig = () => writeFileSync(configFile, JSON.stringify(nativeConfig), { mode: 0o600 });
  saveConfig();
  const controls = new LoopControls(nativeConfig.controlsFile);
  const set = (mode, selected = key) =>
    controls.set(selected, mode, {
      actor: "fixture",
      ...(mode === "active" ? { objective: "只读核对", maxSteps: 2 } : {}),
    });
  const project = { key, nativeId: "project-one", provider: "codex", roots: [root], capabilities: { continue: true } };
  const events = [],
    answers = [],
    cards = [],
    accepted = new Map();
  let stateCalls = 0;
  const readRules = () => JSON.parse(readFileSync(rulesFile, "utf8"));
  const projected = (raw) => ({
    cards: cards.filter((c) => c.state === "open"),
    recentCards: cards.filter((c) => c.state !== "open"),
    sources: Object.keys(raw.sources).map((id) => ({ id })),
    lines: raw.rules.map((r) => ({
      id: r.name,
      name: r.name,
      group: r.group ?? r.name,
      agent: r.to,
      source: r.when.source,
      types: r.when.types,
    })),
    agents: Object.entries(raw.agents).map(([id, a]) => ({
      id,
      name: a.name,
      use: a.use,
      worker: a.worker,
      online: true,
    })),
  });
  const hub = {
    async state() {
      stateCalls++;
      await settings.onState?.({ stateCalls, set, readRules, saveRules });
      if (settings.offline) throw new Error("offline-private-detail");
      return projected(settings.staleState ? rules : readRules());
    },
    async answer(cardId, body) {
      const card = cards.find((c) => c.id === cardId);
      answers.push({
        cardId,
        body,
        mode: controls.get(key).mode,
        rulePresent: readRules().rules.some((r) => r.name === card.rule),
      });
      if (card.state !== "open") return { changed: false, state: card.state };
      card.state = "decided";
      card.choice = body.choice;
      if (settings.loseAnswerAck) throw new Error("answer acknowledgement lost");
      return { changed: true, state: "decided" };
    },
    async event(payload) {
      events.push(structuredClone(payload));
      const prior = accepted.get(payload.id),
        ack = prior ?? { event: accepted.size + 1, routed: [`native-project:${subjectFor(key)}`] };
      if (!prior) accepted.set(payload.id, ack);
      await settings.onEvent?.({ payload, events, set });
      if (settings.loseAcks === "all" || events.length <= (settings.loseAcks ?? 0)) throw new Error("ack lost");
      return { ...ack, ...(prior && { duplicate: true }) };
    },
  };
  const options = {
    nativeConfig,
    configFile,
    controls,
    hubClient: hub,
    confirmAttempts: 3,
    wait: async () => {},
    ...settings.runtimeOptions,
  };
  const runtime = new NativeLoopRuntime(options);
  const sync = (control, action = "enable", requestId = "request-1", selected = key) =>
    runtime.sync({ projectKey: selected, control, action, requestId });
  return {
    dir,
    key,
    otherKey,
    root,
    controlCwd,
    configFile,
    rulesFile,
    hubFile,
    nativeConfig,
    saveConfig,
    controls,
    set,
    project,
    rules,
    readRules,
    saveRules,
    events,
    accepted,
    answers,
    cards,
    runtime,
    options,
    sync,
  };
}

test("readiness requires an unambiguous native root, enabled executor, complete config and authenticated hub state", async (t) => {
  for (const invalid of ["provider", "disabled", "root", "config", "offline"]) {
    const f = fixture(t, { offline: invalid === "offline" });
    if (invalid === "provider") f.project.provider = "dsh";
    if (invalid === "disabled") f.nativeConfig.managedCodex.enabled = false;
    if (invalid === "root") {
      delete f.nativeConfig.managedCodex.projectRoots[f.key];
      f.project.roots.push("/another-native-root");
    }
    if (invalid === "config") delete f.nativeConfig.loopHub.workerName;
    f.saveConfig();
    const ready = await f.runtime.readiness(f.project);
    assert.equal(ready.ready, false);
    assert.equal(ready.rulesReady, false);
    assert.equal(f.events.length, 0);
    assert.deepEqual(f.readRules(), f.rules);
  }
  const f = fixture(t);
  assert.deepEqual(await f.runtime.readiness(f.project), { ready: true, rulesReady: true });
});

test("enable validates, preserves unrelated entries, confirms loaded revision then wakes one stable event", async (t) => {
  const f = fixture(t);
  await f.runtime.readiness(f.project);
  const control = f.set("active"),
    result = await f.sync(control);
  assert.equal(result.ok, true);
  assert.equal(result.emitted, true);
  const raw = f.readRules(),
    name = `native-project:${subjectFor(f.key)}`,
    own = raw.rules.find((r) => r.name === name);
  assert.deepEqual(
    raw.rules.find((r) => r.name === "untouched"),
    f.rules.rules[0],
  );
  assert.deepEqual(raw.agents.unrelated, f.rules.agents.unrelated);
  assert.equal(own.cwd, f.controlCwd);
  assert.notEqual(own.cwd, f.root);
  assert.deepEqual(raw.agents[own.to].command, [f.configFile, f.key]);
  assert.equal(raw.agents[own.to].use, "native-managed");
  assert.equal(raw.agents[own.to].worker, "test-worker");
  assert.ok(own.when.types[0].length <= 64);
  assert.doesNotThrow(() => parseRules(JSON.stringify(raw), Date.now(), "Asia/Shanghai"));
  assert.equal(f.events[0].type, own.when.types[0]);
  assert.equal(f.events[0].subject, subjectFor(f.key));
  assert.equal((await f.sync(control)).emitted, false);
  assert.equal(f.events.length, 1);
});

test("lost acknowledgement retries only identical payload and survives runtime restart without another job", async (t) => {
  const f = fixture(t, { loseAcks: 1 });
  await f.runtime.readiness(f.project);
  const control = f.set("active");
  const result = await f.sync(control);
  assert.equal(result.ok, true);
  assert.equal(f.events.length, 2);
  assert.equal(f.accepted.size, 1);
  assert.deepEqual(f.events[0], f.events[1]);
  const restarted = new NativeLoopRuntime(f.options);
  await restarted.readiness(f.project);
  assert.equal(
    (await restarted.sync({ projectKey: f.key, control, action: "enable", requestId: "request-1" })).emitted,
    false,
  );
  assert.equal(f.events.length, 2);
});

test("three lost acknowledgements become unknown and replay never replenishes the attempt budget", async (t) => {
  const f = fixture(t, { loseAcks: "all" });
  await f.runtime.readiness(f.project);
  const control = f.set("active"),
    result = await f.sync(control);
  assert.equal(result.ok, false);
  assert.equal(result.state, "unknown");
  assert.equal(f.events.length, 3);
  assert.equal((await f.sync(control)).ok, false);
  assert.equal(f.events.length, 3);
  assert.equal(f.accepted.size, 1);
});

test("pause removes only the selected owned rule and sends no event", async (t) => {
  const f = fixture(t);
  await f.runtime.readiness(f.project);
  await f.sync(f.set("active"));
  const raw = f.readRules(),
    otherName = `native-project:${subjectFor(f.otherKey)}`;
  raw.rules.push({
    ...raw.rules.find((r) => r.name.startsWith("native-project:")),
    name: otherName,
    group: otherName,
    when: { source: "native", types: ["native.project.another.changed"] },
  });
  f.saveRules(raw);
  const result = await f.sync(f.set("paused"), "pause", "pause-1");
  assert.equal(result.ok, true);
  assert.equal(result.emitted, false);
  assert.equal(f.events.length, 1);
  assert.ok(f.readRules().rules.some((r) => r.name === otherName));
  assert.ok(f.readRules().rules.some((r) => r.name === "untouched"));
  assert.equal(
    f.readRules().rules.some((r) => r.name === `native-project:${subjectFor(f.key)}`),
    false,
  );
});

test("a stale active revision cannot restore a rule after pause", async (t) => {
  const f = fixture(t);
  await f.runtime.readiness(f.project);
  const active = f.set("active");
  await f.sync(active);
  await f.sync(f.set("paused"), "pause", "pause-1");
  await assert.rejects(f.sync(active), { code: "CONTROL_REVISION_CHANGED" });
  assert.equal(f.events.length, 1);
  assert.equal(f.readRules().rules.length, 1);
});

test("pause while confirming hot reload prevents dispatch and a lost-ack retry", async (t) => {
  const f = fixture(t, {
    onState: ({ stateCalls, set }) => {
      if (stateCalls === 2) set("paused");
    },
  });
  await f.runtime.readiness(f.project);
  const active = f.set("active");
  await assert.rejects(f.sync(active), { code: "CONTROL_REVISION_CHANGED" });
  assert.equal(f.events.length, 0);
  const g = fixture(t, { loseAcks: "all", onEvent: ({ set }) => set("paused") });
  await g.runtime.readiness(g.project);
  await assert.rejects(g.sync(g.set("active")), { code: "CONTROL_REVISION_CHANGED" });
  assert.equal(g.events.length, 1);
});

test("invalid rules and unconfirmed loaded revisions never emit and do not report readiness", async (t) => {
  const f = fixture(t);
  f.saveRules({ ...f.rules, unexpected: true });
  assert.equal((await f.runtime.readiness(f.project)).rulesReady, false);
  const g = fixture(t, { staleState: true });
  await g.runtime.readiness(g.project);
  const active = g.set("active");
  await assert.rejects(g.sync(active), { code: "RULE_SYNC_UNCONFIRMED" });
  assert.equal(g.events.length, 0);
});

test("one stable request identity cannot be retargeted to a new revision", async (t) => {
  const f = fixture(t);
  await f.runtime.readiness(f.project);
  await f.sync(f.set("active"));
  f.set("paused");
  const resumed = f.set("active");
  await assert.rejects(f.sync(resumed, "resume", "request-1"), { code: "LOOP_REQUEST_REUSED" });
  assert.equal(f.events.length, 1);
});

test("readiness dry-runs owned routing and refuses a wildcard that could wake unrelated work", async (t) => {
  const f = fixture(t),
    raw = f.readRules();
  raw.rules.push({
    name: "other-wildcard",
    to: "unrelated",
    cwd: f.controlCwd,
    when: { source: "native", types: ["native.project.*"] },
  });
  f.saveRules(raw);
  const ready = await f.runtime.readiness(f.project);
  assert.equal(ready.rulesReady, false);
  assert.deepEqual(f.readRules(), raw);
  assert.equal(f.events.length, 0);
});

test("sync never activates without stable command identity, and manual mode removes the rule", async (t) => {
  const f = fixture(t);
  await f.runtime.readiness(f.project);
  const active = f.set("active");
  await assert.rejects(f.runtime.sync({ projectKey: f.key, control: active, action: "enable" }), {
    code: "CONTROL_REQUEST_ID_REQUIRED",
  });
  assert.deepEqual(f.readRules(), f.rules);
  await f.sync(active);
  const manual = f.set("manual");
  assert.equal((await f.sync(manual, "manual", "manual-1")).ok, true);
  assert.equal(f.readRules().rules.length, 1);
  assert.equal(f.events.length, 1);
});

const decision = (f, fields = {}) => ({
  id: 7,
  version: 1,
  kind: "ask",
  state: "open",
  rule: `native-project:${subjectFor(f.key)}`,
  title: "请选择下一步",
  text: "已有明确选项",
  options: ["方案一", "方案二"],
  ...fields,
});
const answer = (f, choice = 1, extra = {}) =>
  f.runtime.answerCard({ cardId: 7, choice, actor: "owner", requestId: "answer-1", ...extra });

test("answers target only registered native ask cards and require valid owner input", async (t) => {
  for (const invalid of ["foreign", "unknown", "unregistered", "notice", "choice", "actor"]) {
    const f = fixture(t);
    f.set("paused");
    if (invalid !== "unknown")
      f.cards.push(
        decision(
          f,
          invalid === "foreign"
            ? { rule: "another-rule" }
            : invalid === "unregistered"
              ? { rule: `native-project:${subjectFor("codex:local:unregistered")}` }
              : invalid === "notice"
                ? { kind: "notice" }
                : {},
        ),
      );
    await assert.rejects(answer(f, invalid === "choice" ? 0 : 1, invalid === "actor" ? { actor: " " } : {}));
    assert.equal(f.answers.length, 0);
  }
});

test("ordinary choices are zero-based at the existing hub and duplicate or changed choices do not resubmit", async (t) => {
  const f = fixture(t);
  await f.runtime.readiness(f.project);
  await f.sync(f.set("active"));
  f.cards.push(decision(f));
  const result = await answer(f, 2);
  assert.equal(result.ok, true);
  assert.equal(result.projectKey, f.key);
  assert.equal(result.cardId, 7);
  assert.equal(f.answers[0].body.choice, 1);
  assert.equal(f.controls.get(f.key).mode, "active");
  assert.equal((await answer(f, 1, { requestId: "answer-2" })).changed, false);
  assert.equal(f.answers.length, 1);
});

test("both fixed pause choices remove the rule before answering and cannot wake another run", async (t) => {
  for (const choice of [1, 2]) {
    const f = fixture(t);
    await f.runtime.readiness(f.project);
    await f.sync(f.set("active"));
    f.cards.push(decision(f, { options: ["已核实，保持暂停", "先暂停此目标"] }));
    const result = await answer(f, choice);
    assert.equal(result.ok, true);
    assert.equal(f.controls.get(f.key).mode, "paused");
    assert.equal(f.answers[0].mode, "paused");
    assert.equal(f.answers[0].rulePresent, false);
    assert.equal(f.events.length, 1);
  }
});

test("an ordinary answer cannot enable an already paused project", async (t) => {
  const f = fixture(t);
  await f.runtime.readiness(f.project);
  await f.sync(f.set("active"));
  await f.sync(f.set("paused"), "pause", "pause-1");
  f.cards.push(decision(f));
  const before = f.controls.get(f.key).revision;
  assert.equal((await answer(f)).ok, true);
  assert.equal(f.controls.get(f.key).mode, "paused");
  assert.equal(f.controls.get(f.key).revision, before);
  assert.equal(f.answers[0].rulePresent, false);
});

test("a lost answer acknowledgement is unconfirmed without retrying business and history resolves a later repeat", async (t) => {
  const f = fixture(t, { loseAnswerAck: true });
  f.set("paused");
  f.cards.push(decision(f));
  const result = await answer(f);
  assert.equal(result.ok, false);
  assert.equal(result.state, "unconfirmed");
  assert.equal(f.answers.length, 1);
  assert.match(result.text, /核实/);
  assert.equal((await answer(f)).changed, false);
  assert.equal(f.answers.length, 1);
});

test("the owned prompt advances bounded work, schedules real waiting, and reserves notices for substantial delivery", async (t) => {
  const f = fixture(t);
  await f.runtime.readiness(f.project);
  await f.sync(f.set("active"));
  const prompt = f.readRules().rules.find((r) => r.name.startsWith("native-project:")).prompt;
  for (const text of ["下一步", "later", "ask", "notice", "只读", "不修改原项目", "无变化"])
    assert.ok(prompt.includes(text), text);
});

test("an old closed pause card cannot pause a project that was later explicitly resumed", async (t) => {
  const f = fixture(t);
  await f.runtime.readiness(f.project);
  await f.sync(f.set("active"));
  f.cards.push(decision(f, { state: "closed", options: ["已核实，保持暂停", "先暂停此目标"] }));
  const revision = f.controls.get(f.key).revision;
  const result = await answer(f);
  assert.equal(result.changed, false);
  assert.equal(f.answers.length, 0);
  assert.equal(f.controls.get(f.key).mode, "active");
  assert.equal(f.controls.get(f.key).revision, revision);
});

test("failed pause-rule confirmation keeps pause durable and never submits the answer", async (t) => {
  const f = fixture(t, {
    onState: ({ stateCalls }) => {
      if (stateCalls === 4) throw new Error("hub disconnected");
    },
  });
  await f.runtime.readiness(f.project);
  await f.sync(f.set("active"));
  f.cards.push(decision(f, { options: ["已核实，保持暂停", "先暂停此目标"] }));
  const result = await answer(f);
  assert.equal(result.ok, false);
  assert.equal(result.state, "unconfirmed");
  assert.equal(f.controls.get(f.key).mode, "paused");
  assert.equal(f.answers.length, 0);
});

test("a unique native root needs no redundant mapping, but an explicit non-member is rejected", async (t) => {
  const f = fixture(t);
  delete f.nativeConfig.managedCodex.projectRoots[f.key];
  f.saveConfig();
  assert.equal((await f.runtime.readiness(f.project)).ready, true);
  assert.equal((await f.sync(f.set("active"))).ok, true);
  assert.equal(f.events.length, 1);
  f.nativeConfig.managedCodex.projectRoots[f.key] = "/not-a-native-root";
  f.saveConfig();
  assert.equal((await f.runtime.readiness(f.project)).ready, false);
});

test("removing a multi-root mapping cannot reinterpret a mutable catalogue array as a verified sole root", async (t) => {
  const f = fixture(t);
  f.project.roots.push("/another-native-root");
  assert.equal((await f.runtime.readiness(f.project)).ready, true);
  delete f.nativeConfig.managedCodex.projectRoots[f.key];
  f.project.roots.pop();
  f.saveConfig();
  await assert.rejects(f.sync(f.set("active")), { code: "LOOP_READINESS_REQUIRED" });
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.readRules(), f.rules);
});

test("a root mapping changed after readiness cannot retarget the selected project", async (t) => {
  const f = fixture(t);
  delete f.nativeConfig.managedCodex.projectRoots[f.key];
  assert.equal((await f.runtime.readiness(f.project)).ready, true);
  f.nativeConfig.managedCodex.projectRoots[f.key] = "/another-native-root";
  f.saveConfig();
  await assert.rejects(f.sync(f.set("active")), { code: "LOOP_READINESS_REQUIRED" });
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.readRules(), f.rules);
});

async function decisionClickFixture(t, options = {}) {
  const f = fixture(t);
  if (options.coordinator) f.nativeConfig.managedCodex.coordinatorProjectKeys = [f.key];
  await f.runtime.readiness(f.project);
  const control = f.set("active");
  await f.sync(control);
  const sent = [];
  const server = createServer(async (req, res) => {
    const pieces = [];
    for await (const chunk of req) pieces.push(chunk);
    sent.push({
      url: req.url,
      token: req.headers.authorization,
      body: JSON.parse(Buffer.concat(pieces).toString()),
      mode: f.controls.get(f.key).mode,
    });
    options.onAnswer?.(f);
    if (options.fail) res.writeHead(503).end("{}");
    else res.writeHead(200).end(JSON.stringify({ changed: true, state: "decided" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((r) => server.close(r)));
  const hc = JSON.parse(readFileSync(f.hubFile, "utf8"));
  hc.url = "http://127.0.0.1:" + server.address().port;
  hc.channels = {
    group: {
      key: "fixture-channel-key",
      use: "feishu-group-text",
      profile: "bot",
      chatId: "group-one",
      interactiveAsks: true,
      interactiveAsksFromId: 7,
    },
  };
  writeFileSync(f.hubFile, JSON.stringify(hc));
  const db = new DatabaseSync(path.join(f.dir, "hub.db"));
  t.after(() => db.close());
  db.exec("CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key))");
  const put = (c, k, d) =>
    db.prepare("INSERT OR REPLACE INTO projections VALUES(?,?,?)").run(c, String(k), JSON.stringify(d));
  const raw = f.readRules();
  raw.channels = { group: { name: "group", answerers: ["owner"] } };
  f.saveRules(raw);
  const tgt = f.runtime.desired(f.key, control, f.runtime.layout());
  const card = {
    ...decision(f),
    run_id: 12,
    agent: tgt.agentId,
    grp: tgt.ruleName,
    source: "native",
    lane: "lane",
    options: JSON.stringify(options.options ?? ["first", "second"]),
  };
  put("keys", "channel:group", { kind: "channel", name: "group", hash: digest(hc.channels.group.key) });
  put("cards", 7, card);
  put("runs", 12, {
    id: 12,
    rule: tgt.ruleName,
    agent: tgt.agentId,
    grp: tgt.ruleName,
    lane: "lane",
    rules_version: 4,
  });
  put("config", 4, { value: raw, version: 4 });
  put("config", "rules", { value: raw, version: 4 });
  const delivery = { card_id: 7, channel: "group", version: 1, ref: "om_message" };
  put("deliveries", "7:group", delivery);
  const click = (extra = {}) =>
    f.runtime.answerDecisionClick({
      cardId: 7,
      version: 1,
      choice: 1,
      actor: "owner",
      messageId: "om_message",
      requestId: "feishu-event-1",
      profile: "bot",
      chatId: "group-one",
      ...extra,
    });
  return { ...f, put, card, click, delivery, sent, raw, hc, db };
}

test("a real group-button answer uses only the channel key, zero-based index and delivered message ID", async (t) => {
  const f = await decisionClickFixture(t);
  const answer = await f.click();
  assert.equal(answer.ok, true);
  assert.deepEqual(f.sent, [
    {
      url: "/v1/cards/7/answer",
      token: "Bearer fixture-channel-key",
      body: { choice: 1, by: "owner", ref: "om_message" },
      mode: "active",
    },
  ]);
  assert.equal(f.answers.length, 0);
  f.put("cards", 7, { ...f.card, state: "done", choice: 1, version: 3 });
  f.put("deliveries", "7:group", { ...f.delivery, version: 3 });
  assert.equal((await f.click()).changed, false);
  assert.equal(f.sent.length, 1);
});

test("wrong group/profile/actor/ref/version and out-of-range inputs cannot pause or dispatch", async (t) => {
  const f = await decisionClickFixture(t, { options: ["first", "先暂停此目标"] });
  for (const extra of [
    { profile: "foreign" },
    { chatId: "foreign" },
    { actor: "foreign" },
    { messageId: "om_wrong" },
    { version: 2 },
    { choice: 2 },
    { choice: -1 },
  ]) {
    assert.equal((await f.click(extra)).ok, false);
    assert.equal(f.controls.get(f.key).mode, "active");
  }
  f.put("keys", "channel:group", { name: "group", kind: "channel", hash: digest("rotated") });
  assert.equal((await f.click()).ok, false);
  assert.equal(f.controls.get(f.key).mode, "active");
  assert.equal(f.sent.length, 0);
});

test("a card from a previous activation cannot wake or pause a replacement goal", async (t) => {
  const f = await decisionClickFixture(t, { options: ["ordinary", "先暂停此目标"] });
  f.set("manual");
  f.controls.set(f.key, "active", { actor: "fixture", objective: "replacement", maxSteps: 3 });
  for (const choice of [0, 1]) assert.equal((await f.click({ choice })).ok, false);
  assert.equal(f.controls.get(f.key).mode, "active");
  assert.equal(f.sent.length, 0);
});

test("pause removes routing before channel answer and replay after a transient error stays paused", async (t) => {
  const opts = { options: ["first", "先暂停此目标"], fail: true };
  const f = await decisionClickFixture(t, opts);
  await assert.rejects(f.click());
  assert.equal(f.controls.get(f.key).mode, "paused");
  assert.equal(
    f.readRules().rules.some((r) => r.name === f.card.rule),
    false,
  );
  const pausedRevision = f.controls.get(f.key).revision;
  // The live rules projection has now incorporated the removal.
  f.put("config", "rules", { version: 5, value: f.readRules() });
  opts.fail = false;
  assert.equal((await f.click()).ok, true);
  assert.equal(f.controls.get(f.key).revision, pausedRevision);
  assert.equal(
    f.sent.every((x) => x.mode === "paused"),
    true,
  );
});

test("missing delivery acknowledgement is retriable without committing a choice", async (t) => {
  const f = await decisionClickFixture(t);
  f.put("deliveries", "7:group", { ...f.delivery, version: 0, ref: null });
  await assert.rejects(f.click());
  assert.equal(f.sent.length, 0);
});

test("group opt-in and explicit answerers are required even for a valid group message", async (t) => {
  const f = await decisionClickFixture(t);
  const channel = f.hc.channels.group;
  channel.interactiveAsks = false;
  writeFileSync(f.hubFile, JSON.stringify(f.hc));
  assert.equal((await f.click()).ok, false);
  channel.interactiveAsks = true;
  writeFileSync(f.hubFile, JSON.stringify(f.hc));
  const raw = structuredClone(f.raw);
  delete raw.channels.group.answerers;
  f.put("config", "rules", { version: 5, value: raw });
  assert.equal((await f.click()).ok, false);
  assert.equal(f.sent.length, 0);
});

test("a changed loaded agent cannot take the answer and a second controller cannot replace the goal mid-answer", async (t) => {
  let blocked = false;
  const f = await decisionClickFixture(t, {
    onAnswer(g) {
      assert.throws(() => g.set("active"), { code: "CONTROL_UPDATE_BUSY" });
      blocked = true;
    },
  });
  const swapped = structuredClone(f.raw);
  swapped.agents[f.card.agent].command = [f.configFile, f.otherKey];
  f.put("config", "rules", { version: 5, value: swapped });
  await assert.rejects(f.click());
  assert.equal(f.sent.length, 0);
  f.put("config", "rules", { version: 6, value: f.raw });
  assert.equal((await f.click()).ok, true);
  assert.equal(blocked, true);
});

test("group decision opt-in starts at its explicit inclusive card ID and expired work cannot wake", async (t) => {
  const f = await decisionClickFixture(t);
  const channel = f.hc.channels.group;
  for (const cutoff of [8, 0, null, "7"]) {
    channel.interactiveAsksFromId = cutoff;
    writeFileSync(f.hubFile, JSON.stringify(f.hc));
    assert.equal((await f.click()).ok, false);
  }
  channel.interactiveAsksFromId = 7;
  writeFileSync(f.hubFile, JSON.stringify(f.hc));
  const state = f.controls.read();
  state.projects[f.key].deadline = "2020-01-01T00:00:00Z";
  writeFileSync(f.controls.file, JSON.stringify(state));
  assert.equal((await f.click()).code, "LOOP_CARD_GOAL_INACTIVE");
  assert.equal(f.sent.length, 0);
});

test("a coordinator handoff can wake only the selected project and is disabled for ordinary goals", async (t) => {
  const f = fixture(t);
  f.nativeConfig.managedCodex.coordinatorProjectKeys = [f.key];
  f.saveConfig();
  const changed = "native.project." + subjectFor(f.key).slice(0, 32) + ".changed";
  const handoff = changed.replace(/changed$/, "handoff");
  assert.equal((await f.runtime.readiness(f.project)).ready, true);
  await f.sync(f.set("active"));
  const rule = f.readRules().rules.find((r) => r.to.startsWith("native-managed-"));
  assert.deepEqual(rule.when.types, [changed, handoff]);
  assert.deepEqual(rule.emits, { source: "native", types: [handoff] });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, changed);
  const other = f.runtime.desired(f.otherKey, { revision: 1 }, f.runtime.layout()).rule;
  assert.equal(other.emits, undefined);
  assert.equal(other.when.types.length, 1);
  for (const conflict of [
    { when: { source: "native", types: [handoff] } },
    { emits: { source: "native", types: ["native.project.*"] } },
  ]) {
    const raw = structuredClone(f.rules);
    Object.assign(raw.rules[0], conflict);
    f.saveRules(raw);
    assert.equal((await f.runtime.readiness(f.project)).code, "LOOP_EVENT_SCOPE_CONFLICT");
  }
});

test("only the same coordinator goal can answer its question after pause and resume", async (t) => {
  const f = await decisionClickFixture(t, { coordinator: true });
  await f.sync(f.set("paused"), "pause", "pause-user");
  assert.equal((await f.click()).ok, false);
  const resumed = f.controls.set(f.key, "active", { actor: "fixture" });
  await f.sync(resumed, "resume", "resume-user");
  f.put("config", "rules", { value: f.readRules(), version: 6 });
  assert.equal((await f.click()).ok, true);
  const replaced = f.set("active");
  await f.sync(replaced, "enable", "replace-goal");
  f.put("config", "rules", { value: f.readRules(), version: 7 });
  assert.equal((await f.click()).code, "LOOP_CARD_GOAL_CHANGED");
  assert.equal(f.sent.length, 1);
});

test("typed help replies are required and preserved with the selected card and real message", async (t) => {
  const f = await decisionClickFixture(t, { options: ["我已处理，重新核实", "先暂停此目标"] });
  assert.equal((await f.click({ choice: 0 })).code, "LOOP_CARD_REPLY_REQUIRED");
  assert.equal(f.sent.length, 0);
  const r = await f.click({ choice: 0, answerText: "我没有额外环境，请先在现有授权范围排查" });
  assert.equal(r.ok, true);
  assert.equal(f.sent[0].body.text, "我没有额外环境，请先在现有授权范围排查");
  assert.equal(f.sent[0].body.choice, 0);
});
