// Guard the actual hub/receipt/managed-wrapper flow against polling without a reason, lost continuation context,
// noisy completions, failed attempts replaying stale output, and timers waking a paused project. Only native execution/metadata is substituted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import path from "node:path";
import { setup } from "../../tests/helpers.ts";
import { NativeLoopRuntime } from "./loop-runtime.mjs";
import { LoopControls, subjectFor } from "./controls.mjs";
import { FeishuLoopRelay } from "./feishu-relay.mjs";
import { RelayQueue } from "./relay-queue.mjs";
import { runManagedWorker } from "./managed-worker.mjs";
import adapter from "../../plugins/native-managed/agent.ts";
import { promptFor, readMessage, resultFrom } from "../../worker/contract.ts";

const home = setup("native-execution-flow");
const rulesFile = path.join(home, "rules.json");
const emptyRules = () => ({
  timezone: "Asia/Shanghai",
  sources: { native: { name: "Fixture projects" } },
  agents: {},
  channels: { fixture: { name: "Local delivery queue only", answerers: ["fixture-owner"] } },
  rules: [],
});
writeFileSync(rulesFile, JSON.stringify(emptyRules()), { mode: 0o600 });
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const hub = await import("../../host/runtime.ts");
const receipt = (summary, body) => summary + "\n```agent-autoloop\n" + JSON.stringify(body) + "\n```";

function fixture(t, name, replies, { coordinator = false } = {}) {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers", "schedules"])
    hub.fixtureClear(table);
  writeFileSync(rulesFile, JSON.stringify(emptyRules()), { mode: 0o600 });
  hub.reloadRules();
  const directory = mkdtempSync(path.join(home, name + "-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceRoot = path.join(directory, "source"),
    controlCwd = path.join(directory, "control");
  mkdirSync(sourceRoot);
  mkdirSync(controlCwd);
  const nativeId = "fixture-" + name,
    projectKey = "codex:local:" + nativeId;
  const project = {
    key: projectKey,
    provider: "codex",
    host: "local",
    name: "演示项目",
    nativeId,
    roots: [sourceRoot],
    capabilities: { read: true, continue: true, startOwned: true, continuationMode: "managed-read-only" },
  };
  const configFile = path.join(directory, "native.json"),
    hubFile = path.join(home, name + "-hub.json");
  const config = {
    version: 1,
    providers: {},
    controlsFile: path.join(controlCwd, "modes.json"),
    managedCodex: {
      enabled: true,
      stateDir: path.join(directory, "owned"),
      projectRoots: { [projectKey]: sourceRoot },
      ...(coordinator && { coordinatorProjectKeys: [projectKey] }),
    },
    loopHub: { configFile: hubFile, rulesFile, workerName: "fixture-worker", controlCwd },
  };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(
    hubFile,
    JSON.stringify({
      url: "http://127.0.0.1:1",
      owner: "fixture-only",
      source: { name: "native", key: "fixture-only" },
    }),
    { mode: 0o600 },
  );
  const controls = new LoopControls(config.controlsFile);
  let clock = Date.now(),
    claims = 0,
    ownedByFile = new Map(),
    active = 0,
    closed = 0,
    currentContextFile;
  const executions = [];
  // Transport is an in-process bridge; all decisions, facts, timers, answers and state queries use the real hub.
  const client = {
    async state() {
      hub.reloadRules();
      return hub.stateOf(clock);
    },
    async event(event) {
      return hub.ingest("native", event, clock);
    },
    async answer(id, answer) {
      return hub.answer(id, answer, clock);
    },
  };
  const runtime = new NativeLoopRuntime({ nativeConfig: config, configFile, controls, hubClient: client });
  const eventType = `native.project.${subjectFor(projectKey).slice(0, 32)}.changed`;
  const send = (id) => hub.ingest("native", { id, type: eventType, subject: subjectFor(projectKey) }, clock);
  const claim = () => hub.claimNext("fixture-worker", "claim-" + ++claims, clock);
  const advance = (minutes) => {
    clock += minutes * 60000;
    hub.heartbeat("fixture-worker", [], clock);
    hub.tick(clock);
  };
  const catalog = {
    async refresh() {
      return {
        complete: true,
        projects: [project],
        providers: [{ provider: "codex", status: "connected", complete: true }],
      };
    },
    resolve(key) {
      assert.equal(key, projectKey);
      return { project };
    },
    async close() {},
  };
  const executorFactory = (options) => {
    assert.equal(options.sandbox, "read-only");
    let owned = ownedByFile.get(options.stateFile);
    let running = false,
      turnId,
      text;
    return {
      async createOwnedSession(input) {
        input.beforeMutation();
        const identity = {
          goalId: input.goalId,
          projectId: input.projectId,
          cwd: input.cwd,
          goal: input.goal,
          stateFile: options.stateFile,
        };
        if (owned) assert.deepEqual(identity, owned.identity, "one objective keeps the same owned session identity");
        else {
          owned = { identity, nativeId: "owned-" + name + "-" + ownedByFile.size };
          ownedByFile.set(options.stateFile, owned);
        }
        return { nativeId: owned.nativeId };
      },
      async continueOwned(input) {
        input.beforeMutation();
        assert.equal(input.threadId, owned.nativeId);
        const context = JSON.parse(readFileSync(currentContextFile, "utf8"));
        if (!coordinator)
          assert.ok(input.text.includes(currentContextFile), "the model receives the actual upstream context path");
        const step = replies[executions.length];
        assert.ok(step, "no unplanned model invocation");
        text = step(context, clock, input.text);
        turnId = "turn-" + (executions.length + 1);
        executions.push({ ...input, context, goalId: owned.identity.goalId });
        running = true;
        active++;
        return { accepted: true, executionId: turnId };
      },
      async waitForTurn(input) {
        assert.equal(input.threadId, owned.nativeId);
        assert.equal(input.turnId, turnId);
        running = false;
        active--;
        return {
          nativeId: owned.nativeId,
          executionId: turnId,
          completionVerified: true,
          status: "completed",
          text,
          turnUsage: { input: 5 * executions.length, output: 2 * executions.length },
          turnUsageStatus: "complete",
        };
      },
      async close() {
        assert.equal(running, false, "asking must not keep model work alive");
        closed++;
      },
    };
  };
  async function enable() {
    assert.deepEqual(await runtime.readiness(project), { ready: true, rulesReady: true });
    const control = controls.set(projectKey, "active", {
      actor: "fixture-owner",
      objective: "Complete the bounded fixture goal",
      maxSteps: 8,
      requestId: "enable-" + name,
    });
    return runtime.sync({ projectKey, control, action: "enable", requestId: "enable-" + name });
  }
  async function executeNext() {
    const job = claim();
    if (!job) return null;
    currentContextFile = path.join(directory, "context-" + job.run + "-" + job.attempt + ".json");
    writeFileSync(currentContextFile, JSON.stringify(job.context), { mode: 0o600 });
    const prompt = promptFor(job, currentContextFile);
    const argv = adapter.command({
      prompt,
      command: job.agent.command,
      cwd: job.rule.cwd,
      access: job.agent.access,
      session: job.session ?? "",
      resume: job.session,
      contextFile: currentContextFile,
      folder: controlCwd,
    });
    assert.deepEqual(argv.slice(-3), [configFile, projectKey, prompt]);
    const output = [];
    const result = await runManagedWorker(
      {
        config,
        contextFile: currentContextFile,
        projectKey: argv.at(-2),
        prompt: argv.at(-1),
        runId: String(job.run),
        attempt: job.attempt,
      },
      {
        controls,
        catalog,
        executorFactory,
        emit(event) {
          output.push(event);
          if (event.type === "native.started") hub.started(job.run, job.token, { session: event.session }, clock);
        },
      },
    );
    const reading = adapter.read(output.map((event) => JSON.stringify(event)).join("\n"), 0, "");
    assert.equal(reading.finished, true);
    const parsed = resultFrom(readMessage(reading.text), { session: reading.session, usage: reading.usage });
    assert.equal(parsed.problem, undefined);
    assert.deepEqual(hub.finish(job.run, job.token, parsed.result, clock).rejected, []);
    return { job, result, parsed: parsed.result };
  }
  return {
    directory,
    catalog,
    project,
    hubFile,
    sourceRoot,
    runtime,
    controls,
    projectKey,
    send,
    enable,
    executeNext,
    claim,
    advance,
    executions,
    state: () => hub.stateOf(clock),
    nextCard: () => hub.nextCard("fixture", clock),
    deliver: (card) => hub.delivered("fixture", card.id, card.version, "fixture-card", clock),
    waitingTimers: () => hub.all("SELECT id FROM timers WHERE event_id IS NULL"),
    counts: () => ({ active, closed }),
  };
}

async function bindGroupChannel(t, f) {
  const { serve } = await import("../../host/http.ts");
  const server = serve(0);
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const settings = JSON.parse(readFileSync(f.hubFile, "utf8"));
  settings.url = "http://127.0.0.1:" + server.address().port;
  settings.channels = {
    fixture: {
      use: "feishu-group-text",
      interactiveAsks: true,
      interactiveAsksFromId: 1,
      profile: "test",
      chatId: "oc_t",
      key: hub.addKey("channel", "fixture"),
    },
  };
  writeFileSync(f.hubFile, JSON.stringify(settings));
}

test("selected native goals use upstream events, receipts, timers and answers without an extra scheduler", async (t) => {
  t.after(() => hub.db.close());

  for (const route of ["ask", "dispatch"])
    await t.test("named IM goal coordinates with a separate worker via " + route, async (t) => {
      const routes = ["先试员工首次使用", "先试部件接口"];
      const decision = {
        action: route,
        progress: "一页试用草案已就绪",
        nextStep: "围绕试用重点生成检查清单",
        expectedResult: "可执行的条目",
      };
      if (route === "ask")
        Object.assign(decision, {
          question: "第一轮试用优先看什么？",
          options: routes,
          recommend: 0,
          reason: "首轮先确认员工能走完整个流程，再扩大范围。",
        });
      const final = { action: "deliver", summary: "试用清单已准备", deliverable: "1. 核对输入。\n2. 测试交付结果。" };
      const f = fixture(
        t,
        "owner-" + route,
        [
          () => JSON.stringify(decision),
          (context, clock, text) => {
            assert.equal(context.events.length, 1);
            assert.ok(text.includes(decision.nextStep), "worker receives the coordinator's actual plan");
            if (route === "ask") {
              assert.equal(context.events[0].type, "card.answered");
              assert.equal(context.answers[0].choice, 1);
              assert.ok(
                text.includes(routes[1]),
                "worker receives the owner's choice, even when different from the recommendation",
              );
            } else assert.ok(context.events[0].type.endsWith(".handoff"));
            return JSON.stringify(final);
          },
        ],
        { coordinator: true },
      );
      writeFileSync(path.join(f.sourceRoot, "AGENTS.md"), "已准备好一页试用草案。");
      await bindGroupChannel(t, f);
      const queuePath = path.join(f.directory, "im.ndjson");
      const naturalRoutingFile = path.join(f.directory, "routing.json");
      const config = {
        chatId: "oc_t",
        allowedSenderIds: ["fixture-owner"],
        queuePath,
        naturalRoutingFile,
        profile: "test",
      };
      writeFileSync(queuePath, "");
      writeFileSync(
        naturalRoutingFile,
        JSON.stringify({
          ...config,
          enabled: true,
          botMentionIds: ["ou_bot"],
          projectNames: [f.project.name],
          directGoalProjects: [{ name: f.project.name, projectKey: f.projectKey, enabledAt: "2026-01-01T00:00:00Z" }],
        }),
      );
      const queue = new RelayQueue(path.join(f.directory, "im.db"));
      t.after(() => queue.close());
      const relay = new FeishuLoopRelay(config, {
        queue,
        controls: f.controls,
        catalog: f.catalog,
        canCoordinate: (key) => key === f.projectKey,
        cards: { enabled: () => true, prepare: async () => null },
        readiness: (p) => f.runtime.readiness(p),
        syncRules: (args) => f.runtime.sync(args),
        reply: async () => "om_ack",
      });
      await relay.tick();
      const event = {
        message_id: "om_pilot_" + route,
        message_type: "text",
        sender_type: "user",
        sender_id: "fixture-owner",
        chat_id: "oc_t",
        create_time: String(Date.now()),
        mentions: [{ id: "ou_bot", name: "Bot" }],
        content: "@Bot 演示项目，帮我准备一份小组试用方案。",
      };
      appendFileSync(queuePath, JSON.stringify(event) + "\n");
      await relay.tick();
      assert.match(queue.get(event.message_id).response, /先看/);
      const first = await f.executeNext();
      assert.equal(
        (route === "ask" ? first.parsed.ask : first.parsed.events)?.length,
        1,
        first.result.errorCode ?? first.parsed.summary,
      );
      if (route === "ask") {
        const ask = f.nextCard();
        assert.equal(ask.kind, "ask");
        assert.equal(ask.recommend, 0);
        assert.ok(ask.text.includes(decision.reason));
        assert.equal(await f.executeNext(), null);
        hub.delivered("fixture", ask.id, ask.version, "om_original_question");
        const click = {
          cardId: ask.id,
          version: ask.version,
          choice: 1,
          actor: "fixture-owner",
          profile: "test",
          chatId: "oc_t",
          messageId: "om_original_question",
          requestId: "owner-click",
        };
        assert.equal((await f.runtime.answerDecisionClick(click)).changed, true);
        assert.equal((await f.runtime.answerDecisionClick(click)).changed, false);
      }
      f.advance(1);
      const work = await f.executeNext();
      assert.ok(work?.parsed.notice?.some((x) => x.text.includes("测试交付结果")));
      assert.equal(f.executions.length, 2);
      assert.notEqual(f.executions[0].threadId, f.executions[1].threadId);
      assert.equal(await f.executeNext(), null);
      assert.equal(f.waitingTimers().length, 0);
    });
  await t.test(
    "a mobile choice uses the delivered Feishu message and wakes precisely the chosen native branch",
    async (t) => {
      const f = fixture(t, "mobile-decision", [
        () =>
          receipt("Choose the acceptance scope", {
            ask: [{ title: "Which scope?", text: "Select one", options: ["Navigation", "Contracts"] }],
          }),
        (context) => {
          assert.equal(context.events[0].type, "card.answered");
          assert.equal(context.answers[0].options[context.answers[0].choice], "Contracts");
          return "Contract checklist completed";
        },
      ]);
      await bindGroupChannel(t, f);
      await f.enable();
      await f.executeNext();
      const ask = f.nextCard();
      hub.delivered("fixture", ask.id, ask.version, "om_question");
      assert.equal(await f.executeNext(), null);
      const click = {
        cardId: ask.id,
        version: ask.version,
        choice: 1,
        actor: "fixture-owner",
        profile: "test",
        chatId: "oc_t",
        messageId: "om_question",
        requestId: "click-1",
      };
      assert.equal((await f.runtime.answerDecisionClick({ ...click, messageId: "om_other" })).ok, false);
      assert.equal((await f.runtime.answerDecisionClick(click)).changed, true);
      assert.equal((await f.runtime.answerDecisionClick(click)).changed, false);
      f.advance(1);
      await f.executeNext();
      assert.equal(f.executions.length, 2);
      assert.equal(f.executions[0].threadId, f.executions[1].threadId);
      assert.equal(await f.executeNext(), null);
    },
  );
  await t.test("manual does nothing, and plain completion neither notifies nor fills remaining budget", async (t) => {
    const f = fixture(t, "ordinary", [() => "The requested work is complete"]);
    assert.equal(f.controls.get(f.projectKey).mode, "manual");
    assert.deepEqual(f.send("before-selection").routed, []);
    assert.equal(await f.executeNext(), null);
    assert.equal(f.executions.length, 0);
    assert.equal((await f.enable()).ok, true);
    const first = await f.executeNext();
    assert.equal(first.parsed.outcome, "done");
    assert.equal(f.state().cards.length, 0);
    assert.equal(f.state().recentCards.length, 0);
    assert.equal(f.nextCard(), null);
    for (const minutes of [60, 60, 1440]) {
      f.advance(minutes);
      assert.equal(await f.executeNext(), null);
    }
    assert.equal(f.executions.length, 1);
    assert.equal(f.state().runs.length, 1);
    assert.equal(f.waitingTimers().length, 0);
    assert.equal(f.nextCard(), null);
    assert.equal(f.controls.get(f.projectKey).maxSteps, 8);
    assert.deepEqual(f.counts(), { active: 0, closed: 1 });
  });
  await t.test(
    "later resumes one goal/session, ask exits, and an owner answer alone starts the final turn",
    async (t) => {
      const f = fixture(t, "continuation", [
        (context, clock) => {
          assert.equal(context.answers.length, 0);
          return receipt("First step finished; awaiting evidence", {
            later: [
              {
                key: "inspect-result",
                at: new Date(clock + 10 * 60000).toISOString(),
                about: "Inspect the ready evidence before continuing",
              },
            ],
          });
        },
        (context) => {
          assert.equal(context.timers[0].key, "inspect-result");
          assert.match(context.timers[0].about, /ready evidence/);
          return receipt("An owner decision is needed", {
            ask: [
              {
                title: "Choose a route",
                text: "Either route is available",
                options: ["Route A", "Route B"],
                key: "route",
                about: "Continue only the chosen route; preserve prior work",
              },
            ],
          });
        },
        (context) => {
          assert.equal(context.answers[0].choice, 1);
          assert.match(context.answers[0].about, /preserve prior work/);
          return "Chosen route completed; goal is complete";
        },
      ]);
      await f.enable();
      const first = await f.executeNext();
      assert.equal(first.parsed.outcome, "done");
      assert.equal(f.waitingTimers().length, 1);
      assert.equal(f.nextCard(), null);
      f.advance(9);
      assert.equal(await f.executeNext(), null);
      assert.equal(f.executions.length, 1);
      f.advance(1);
      const second = await f.executeNext();
      assert.equal(second.job.session, first.result.session);
      assert.equal(f.executions[1].goalId, f.executions[0].goalId);
      const ask = f.nextCard();
      assert.equal(ask.kind, "ask");
      f.deliver(ask);
      assert.deepEqual(f.counts(), { active: 0, closed: 2 });
      assert.equal(f.waitingTimers().length, 0);
      for (const minutes of [60, 60]) {
        f.advance(minutes);
        assert.equal(await f.executeNext(), null);
        assert.equal(f.nextCard(), null);
      }
      assert.equal(f.executions.length, 2);
      const answer = await f.runtime.answerCard({
        cardId: ask.id,
        choice: 2,
        actor: "fixture-owner",
        requestId: "answer-continuation",
      });
      assert.equal(answer.ok, true);
      const third = await f.executeNext();
      assert.equal(third.job.session, first.result.session);
      assert.equal(third.parsed.later, undefined);
      assert.equal(f.state().cards.length, 0);
      assert.equal(f.state().recentCards[0].state, "done");
      assert.ok(
        f.state().recentCards.every((card) => card.kind === "ask"),
        "completion creates no notice card",
      );
      const update = f.nextCard();
      if (update) {
        assert.equal(update.id, ask.id);
        f.deliver(update);
      }
      f.advance(180);
      assert.equal(await f.executeNext(), null);
      assert.equal(f.nextCard(), null);
      assert.equal(f.executions.length, 3);
      assert.equal(new Set(f.executions.map((e) => e.threadId)).size, 1);
      assert.equal(new Set(f.executions.map((e) => e.goalId)).size, 1);
      assert.equal(f.waitingTimers().length, 0);
      assert.deepEqual(f.counts(), { active: 0, closed: 3 });
    },
  );
  await t.test(
    "a known failure waits five minutes then executes attempt two in the same run and session",
    async (t) => {
      const f = fixture(t, "retry", [() => "没跑成：暂时无法读取", () => "读取已恢复，目标已完成"]);
      await f.enable();
      const first = await f.executeNext();
      assert.equal(first.job.attempt, 1);
      assert.equal(first.parsed.outcome, "failed");
      assert.deepEqual(first.parsed.usage, { input: 5, output: 2 });
      assert.equal(f.state().runs[0].state, "queued");
      assert.equal(f.state().cards.length, 0);
      assert.equal(f.state().recentCards.length, 0);
      assert.equal(f.nextCard(), null, "the first failure does not reach the third-failure notification threshold");
      f.advance(4.5);
      assert.equal(await f.executeNext(), null);
      assert.equal(f.executions.length, 1);
      f.advance(0.5);
      const second = await f.executeNext();
      assert.equal(second.job.run, first.job.run);
      assert.equal(second.job.attempt, 2);
      assert.equal(second.job.session, first.result.session);
      assert.equal(second.parsed.outcome, "done");
      assert.deepEqual(
        second.parsed.usage,
        { input: 10, output: 4 },
        "the new attempt reports its own execution usage",
      );
      assert.equal(f.executions.length, 2, "attempt two invokes the executor rather than replaying the failed result");
      assert.equal(new Set(f.executions.map((e) => e.requestId)).size, 2);
      assert.equal(new Set(f.executions.map((e) => e.threadId)).size, 1);
      assert.equal(new Set(f.executions.map((e) => e.goalId)).size, 1);
      const [run] = f.state().runs;
      assert.equal(f.state().runs.length, 1);
      assert.equal(run.state, "done");
      assert.deepEqual(run.usage, { input: 15, output: 6 });
      assert.equal(f.state().cards.length, 0);
      assert.equal(f.state().recentCards.length, 0);
      f.advance(180);
      assert.equal(await f.executeNext(), null);
      assert.equal(f.nextCard(), null);
      assert.equal(f.executions.length, 2);
      assert.equal(f.controls.get(f.projectKey).maxSteps, 8);
      assert.deepEqual(f.counts(), { active: 0, closed: 2 });
    },
  );
  await t.test(
    "pause removes the selected rule before a timer is due and blocks subsequent old-source events",
    async (t) => {
      const f = fixture(t, "pause", [
        (context, clock) =>
          receipt("Waiting for the result", {
            later: [
              { key: "later-result", at: new Date(clock + 10 * 60000).toISOString(), about: "Inspect the result" },
            ],
          }),
      ]);
      await f.enable();
      await f.executeNext();
      assert.equal(f.waitingTimers().length, 1);
      const paused = f.controls.set(f.projectKey, "paused", { actor: "fixture-owner" });
      assert.equal(
        (
          await f.runtime.sync({
            projectKey: f.projectKey,
            control: paused,
            action: "pause",
            requestId: "pause-fixture",
          })
        ).ok,
        true,
      );
      assert.equal(
        f.state().lines.some((line) => line.id === `native-project:${subjectFor(f.projectKey)}`),
        false,
      );
      f.advance(10);
      assert.equal(await f.executeNext(), null);
      assert.equal(f.waitingTimers().length, 0);
      assert.deepEqual(f.send("old-source-after-pause").routed, []);
      assert.equal(await f.executeNext(), null);
      f.advance(120);
      assert.equal(await f.executeNext(), null);
      assert.equal(f.executions.length, 1);
      assert.deepEqual(f.counts(), { active: 0, closed: 1 });
      assert.equal(f.controls.get(f.projectKey).mode, "paused");
    },
  );
});
