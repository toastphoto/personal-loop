// A completion-driven goal must not hit the kernel's emitted-event depth limit or forget a human choice after resuming.
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setup } from "../../tests/helpers.ts";
import { LoopControls, subjectFor } from "./controls.mjs";
import { NativeLoopRuntime } from "./loop-runtime.mjs";
import { runManagedWorker } from "./managed-worker.mjs";
import { settleCompletedGoals } from "./goal-completion.mjs";
import { promptFor, readMessage, resultFrom } from "../../worker/contract.ts";

const home = realpathSync(setup("continuous-native-goal"));
const rulesFile = path.join(home, "rules.json");
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const empty = {
  sources: { native: { name: "Fixture" } },
  agents: {},
  channels: { local: { name: "No external channel" } },
  rules: [],
  timezone: "Asia/Shanghai",
};
writeFileSync(rulesFile, JSON.stringify(empty));
const hub = await import("../../host/runtime.ts");
chmodSync(path.join(home, "hub.db"), 0o600);

test("the real hub drives more than eight bounded handoffs, preserves a nonrecommended choice, and resumes an observed step without repeating it", async (t) => {
  t.after(() => hub.db.close());
  const cwd = path.join(home, "project"),
    controlCwd = path.join(home, "control");
  mkdirSync(cwd);
  mkdirSync(controlCwd);
  writeFileSync(path.join(cwd, "AGENTS.md"), "Fixture project only.");
  const projectKey = "codex:local:real-core-fixture",
    projectId = "real-core-fixture",
    threadId = "11111111-1111-1111-1111-111111111111";
  const configFile = path.join(home, "native.json");
  const config = {
    providers: { codex: { allowConversationPreview: true } },
    controlsFile: path.join(home, "control.json"),
    managedCodex: {
      enabled: true,
      stateDir: path.join(home, "owned"),
      projectRoots: { [projectKey]: cwd },
      coordinatorProjectKeys: [projectKey],
      boundChats: { [projectKey]: { threadId, projectId, root: cwd } },
    },
    loopHub: { rulesFile, configFile: path.join(home, "private-hub.json"), workerName: "fixture", controlCwd },
  };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const controls = new LoopControls(config.controlsFile);
  const initial = controls.set(projectKey, "active", {
    actor: "fixture-owner",
    objective: "核对六个具体场景并给出验收",
    maxSteps: null,
    requestId: "first",
  });
  const runtime = new NativeLoopRuntime({ nativeConfig: config, configFile, controls });
  const layout = { sourceName: "native", workerName: "fixture", controlCwd };
  const loadRules = () => {
    const raw = structuredClone(empty);
    const control = controls.get(projectKey);
    if (control.mode === "active") {
      const desired = runtime.desired(projectKey, control, layout);
      runtime.candidate(raw, desired, projectKey, true, layout);
    }
    writeFileSync(rulesFile, JSON.stringify(raw));
    hub.reloadRules();
  };
  loadRules();
  const settled = () =>
    settleCompletedGoals({
      nativeConfig: config,
      configFile,
      controls,
      runtime: {
        async sync({ control, action }) {
          assert.equal(control.mode, "manual");
          assert.equal(action, "manual");
          loadRules();
          return { ok: true };
        },
      },
    });
  const subject = subjectFor(projectKey),
    eventType = "native.project." + subject.slice(0, 32) + ".changed";
  let clock = Date.now(),
    queueCount = 0,
    planCount = 0,
    claims = 0,
    resumed = false;
  const ids = [],
    queued = [];
  const send = () =>
    hub.ingest("native", { id: controls.get(projectKey).goalControlEvent, type: eventType, subject }, clock);
  send();
  const deps = {
    controls,
    catalog: {
      async refresh() {},
      resolve() {
        return { project: { key: projectKey, nativeId: projectId, provider: "codex", roots: [cwd] } };
      },
      async close() {},
    },
    emit() {},
    executorFactory() {
      throw Error("must not create an owned conversation");
    },
    readBoundProgress: async () => ({ title: "Primary fixture chat", excerpt: "原对话进展", complete: true }),
    runEphemeralCoordinator: async ({ beforeStart, prompt }) => {
      beforeStart();
      planCount++;
      let out;
      if (planCount === 1)
        out = {
          action: "ask",
          progress: "准备核对真实场景",
          nextStep: "检查具体样例1",
          expectedResult: "样例1说明",
          question: "选择重点",
          options: ["界面", "数据"],
          recommend: 0,
          reason: "界面较容易查看",
        };
      else if (queueCount === 6)
        out = { action: "finish", summary: "六个样例均已核对", reason: "原聊天六份带结果的样例都已逐步确认" };
      else {
        assert.match(prompt, /数据/, "the owner's nonrecommended branch remains in review context");
        assert.match(prompt, /本目标最近已核对过的步骤/);
        out = {
          action: "dispatch",
          progress: "已有样例结果",
          nextStep: "检查具体样例" + (queueCount + 1),
          expectedResult: "样例" + (queueCount + 1) + "说明",
        };
      }
      return { text: JSON.stringify(out), turnUsage: { input: 12, output: 7 }, turnUsageStatus: "complete" };
    },
    queueBoundChat: async ({ requestId, text, beforeMutation }) => {
      beforeMutation();
      if (queueCount === 0) assert.match(text, /数据/);
      else assert.doesNotMatch(text, /刚刚选定|本目标此前已经确认/);
      queueCount++;
      ids.push(requestId);
      queued.push(text);
      if (queueCount === 3) {
        controls.set(projectKey, "paused", { actor: "fixture-owner", requestId: "pause" });
        loadRules();
      }
      return {
        threadId,
        status: "completed",
        turnId: "native-turn-" + queueCount,
        reply: "样例" + queueCount + "已检查，已有结果和验收说明。",
      };
    },
  };
  let done = false,
    turns = 0;
  for (let i = 0; i < 30; i++) {
    const job = hub.claimNext("fixture", "claim-" + ++claims, clock);
    if (!job) {
      assert(!done, "finished goal must not schedule more work");
      if (controls.get(projectKey).mode === "paused") {
        assert.equal(queueCount, 3);
        assert.equal(resumed, false);
        controls.set(projectKey, "active", { actor: "fixture-owner", requestId: "resume" });
        loadRules();
        send();
        resumed = true;
        continue;
      }
      const pending = hub.all("SELECT at FROM timers WHERE event_id IS NULL");
      assert.equal(pending.length, 1, JSON.stringify({ queueCount, planCount, state: hub.stateOf(clock) }));
      clock = Math.max(clock + 1, Date.parse(pending[0].at) + 1);
      hub.tick(clock);
      continue;
    }
    turns++;
    const file = path.join(home, "context-" + job.run + ".json");
    writeFileSync(file, JSON.stringify(job.context));
    const result = await runManagedWorker(
      {
        config,
        projectKey,
        runId: String(job.run),
        attempt: job.attempt,
        prompt: promptFor(job, file),
        contextFile: file,
      },
      deps,
    );
    const parsed = resultFrom(readMessage(result.text), { usage: result.usage }).result;
    if (result.coordinator?.action === "finish") {
      assert.deepEqual(await settled(), [], "a planner finish is not enough before hub acknowledgement");
      assert.equal(controls.get(projectKey).mode, "active");
    }
    assert.equal(hub.finish(job.run, job.token, parsed, clock).rejected.length, 0, result.text);
    if (parsed.ask?.length) {
      const card = hub.nextCard("local", clock);
      assert.equal(card.recommend, 0);
      hub.delivered("local", card.id, card.version, "fixture-message", clock);
      assert.equal(
        hub.answer(card.id, { choice: 1, by: "fixture-owner", ref: "fixture-message" }, clock).changed,
        true,
      );
    }
    if (result.coordinator?.action === "finish") {
      done = true;
      break;
    }
  }
  assert.equal(done, true);
  assert.equal(queueCount, 6);
  assert.ok(turns > 8);
  assert.equal(resumed, true);
  assert.equal(new Set(ids).size, 6);
  assert.equal(controls.get(projectKey).goalRevision, initial.goalRevision);
  assert.equal(hub.all("SELECT id FROM timers WHERE event_id IS NULL").length, 0);
  assert.equal(hub.claimNext("fixture", "after-finish", clock), null);
  const events = hub.db
    .prepare("SELECT json_extract(data,'$.hops') AS hops FROM projections WHERE collection='events'")
    .all();
  assert.ok(events.every((e) => e.hops <= 1));
  assert.equal(
    hub.stateOf(clock).cards.some((c) => c.title === "事件循环已停止"),
    false,
  );
  assert.equal(
    queued.filter((x) => x.includes("检查具体样例3")).length,
    1,
    "pause must not requeue the already completed third step",
  );
  assert.deepEqual(await settled(), [{ projectKey, goalRevision: initial.goalRevision, status: "completed" }]);
  assert.equal(controls.get(projectKey).mode, "manual");
});
