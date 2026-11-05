// Prevent inert enables, lost-ack duplicate jobs, cross-project rule edits, and stale enables undoing pause.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
