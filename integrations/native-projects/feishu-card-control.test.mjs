// Reject forged/stale/replayed clicks and keep saved goals separate from actual project activation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CardSessions, ProjectCardController } from "./feishu-card-control.mjs";
import { LoopControls } from "./controls.mjs";
import { projectAlias } from "./feishu-commands.mjs";
const project = {
  key: "codex:local:a",
  provider: "codex",
  host: "local",
  nativeId: "a",
  name: "Demo",
  capabilities: { read: true, startOwned: true, continuationMode: "managed-read-only" },
};
const config = { chatId: "oc_group", allowedSenderIds: ["ou_owner"] };
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "card-control-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new CardSessions(path.join(dir, "cards.db"));
  t.after(() => store.close());
  const controls = new LoopControls(path.join(dir, "modes.json"));
  const catalog = {
    refresh: async () => ({
      complete: true,
      providers: [{ provider: "codex", status: "connected", complete: true }],
      projects: [project],
    }),
    listWork: async () => ({ items: [], complete: true }),
  };
  const runtime = { readiness: async () => ({ ready: true, rulesReady: true }), sync: async () => ({ ok: true }) };
  const controller = new ProjectCardController(config, { store, controls, catalog, runtime });
  return { store, controls, controller, runtime };
}
function nodes(v) {
  return v && typeof v === "object" ? [v, ...Object.values(v).flatMap(nodes)] : [];
}
function action(response, name) {
  const v = nodes(response.card)
    .flatMap((o) => o.behaviors ?? [])
    .map((o) => o.value)
    .find((v) => v?.action === name);
  assert.ok(v, "missing action " + name);
  return v;
}
let seq = 0;
function event(response, value, extra = {}) {
  return {
    eventId: "e" + ++seq,
    cardMessageId: "om_card",
    actor: "ou_owner",
    chat: "oc_group",
    host: "im_message",
    actionTag: "button",
    actionValue: JSON.stringify(value),
    actionName: "",
    formValue: "",
    option: "",
    ...extra,
  };
}
async function opened(f) {
  const response = await f.controller.prepare(
    { id: "om_source", requestId: "req", event: { sender_id: "ou_owner", chat_id: "oc_group" } },
    { ok: true, view: { kind: "project-directory" } },
  );
  f.controller.bind(response.sessionId, "om_card");
  return response;
}
async function probed(f) {
  let r = await opened(f);
  r = await f.controller.handle(event(r, action(r, "probe")));
  return r;
}
async function detailed(f) {
  let r = await probed(f);
  const selected = nodes(r.card).find(
    (o) =>
      o.tag === "button" &&
      o.behaviors?.[0]?.value.action === "detail" &&
      o.behaviors[0].value.alias === projectAlias(project),
  );
  return f.controller.handle(event(r, selected.behaviors[0].value));
}
async function saveGoal(f, r) {
  r = await f.controller.handle(event(r, action(r, "edit-goal")));
  const submit = nodes(r.card).find((o) => o.form_action_type === "submit");
  return f.controller.handle(
    event(r, {}, { actionName: submit.name, formValue: JSON.stringify({ objective: "Inspect demo", max_steps: "3" }) }),
  );
}
test("only a real bound owner callback verifies the connection", async (t) => {
  const f = fixture(t),
    r = await opened(f);
  assert.equal(f.store.verified(f.controller.scope), false);
  for (const bad of [
    { actor: "ou_other" },
    { chat: "oc_other" },
    { cardMessageId: "om_forged" },
    { host: "im_top_notice" },
  ])
    await assert.rejects(f.controller.handle(event(r, action(r, "probe"), bad)));
  assert.equal(f.store.verified(f.controller.scope), false);
  await f.controller.handle(event(r, action(r, "probe")));
  assert.equal(f.store.verified(f.controller.scope), true);
  assert.equal(f.controls.get(project.key).mode, "manual");
});
test("saving a goal never activates a project; start requires the issued confirmation", async (t) => {
  const f = fixture(t);
  let r = await detailed(f);
  r = await saveGoal(f, r);
  assert.equal(f.controls.get(project.key).mode, "manual");
  assert.equal(f.store.draft("ou_owner", "oc_group", projectAlias(project)).objective, "Inspect demo");
  await assert.rejects(f.controller.handle(event(r, { ...action(r, "start"), action: "confirm-start" })), {
    code: "CARD_ACTION_NOT_ISSUED",
  });
  r = await f.controller.handle(event(r, action(r, "start")));
  assert.equal(f.controls.get(project.key).mode, "manual");
  r = await f.controller.handle(event(r, action(r, "confirm-start")));
  assert.equal(f.controls.get(project.key).mode, "active");
  assert.equal(f.controls.get(project.key).objective, "Inspect demo");
  assert.ok(JSON.stringify(r.card).includes("暂停后续推进"));
});
test("replayed events do not mutate twice and old cards cannot undo a newer pause", async (t) => {
  const f = fixture(t);
  let r = await saveGoal(f, await detailed(f));
  r = await f.controller.handle(event(r, action(r, "start")));
  const click = event(r, action(r, "confirm-start"));
  const done = await f.controller.handle(click);
  assert.equal(f.controls.get(project.key).revision, 1);
  assert.deepEqual(await f.controller.handle(click), done);
  assert.equal(f.controls.get(project.key).revision, 1);
  f.controls.set(project.key, "paused", { actor: "owner" });
  const stale = await f.controller.handle(event(r, action(r, "confirm-start")));
  assert.equal(f.controls.get(project.key).mode, "paused");
  assert.equal(f.controls.get(project.key).revision, 2);
  assert.ok(stale.card);
});
test("a separate card with an old control revision cannot resume a newer decision", async (t) => {
  const f = fixture(t);
  let r = await saveGoal(f, await detailed(f));
  r = await f.controller.handle(event(r, action(r, "start")));
  f.controls.set(project.key, "paused", { actor: "owner" });
  await f.controller.handle(event(r, action(r, "confirm-start")));
  assert.equal(f.controls.get(project.key).mode, "paused");
  assert.equal(f.controls.get(project.key).revision, 1);
});
test("resume uses the original goal, not an edited draft, and does not reset its budget", async (t) => {
  const f = fixture(t);
  f.controls.set(project.key, "active", { actor: "owner", objective: "Original goal", maxSteps: 5 });
  f.controls.set(project.key, "paused", { actor: "owner" });
  let r = await detailed(f);
  r = await saveGoal(f, r);
  r = await f.controller.handle(event(r, action(r, "resume")));
  r = await f.controller.handle(event(r, action(r, "confirm-resume")));
  assert.equal(f.controls.get(project.key).objective, "Original goal");
  assert.equal(f.controls.get(project.key).maxSteps, 5);
  assert.equal(f.controls.get(project.key).mode, "active");
});
test("form submission rejects forged names and invalid budgets without changing draft or mode", async (t) => {
  const f = fixture(t);
  let r = await detailed(f);
  r = await f.controller.handle(event(r, action(r, "edit-goal")));
  const submit = nodes(r.card).find((o) => o.form_action_type === "submit");
  for (const value of [
    { objective: "x", max_steps: "0" },
    { objective: "x".repeat(1001), max_steps: "3" },
    { objective: "x", max_steps: "7" },
    { objective: "x", max_steps: "3", extra: "bad" },
  ])
    await assert.rejects(
      f.controller.handle(event(r, {}, { actionName: submit.name, formValue: JSON.stringify(value) })),
    );
  assert.equal(f.store.draft("ou_owner", "oc_group", projectAlias(project)), null);
  assert.equal(f.controls.get(project.key).mode, "manual");
});
test("session binding and request identity survive restart and cannot be retargeted", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "store.db");
  let store = new CardSessions(file);
  const s = store.create("req", "actor", "chat", () => ({ card: {}, view: {} }));
  store.bind(s.id, "om_card");
  store.close();
  store = new CardSessions(file);
  t.after(() => store.close());
  assert.equal(store.create("req", "actor", "chat", () => ({ wrong: true })).id, s.id);
  assert.throws(() => store.create("req", "other", "chat", () => ({})));
  assert.throws(() => store.bind(s.id, "om_other"));
  assert.equal(store.get(s.id).messageId, "om_card");
});

test("a crash after enabling but before rule sync recovers to pause without repeating execution", async (t) => {
  const f = fixture(t);
  let r = await saveGoal(f, await detailed(f));
  r = await f.controller.handle(event(r, action(r, "start")));
  const click = event(r, action(r, "confirm-start"));
  const { createHash } = await import("node:crypto");
  const sort = (v) =>
    v && typeof v === "object"
      ? Array.isArray(v)
        ? v.map(sort)
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
      : v;
  const hash = (v) =>
    createHash("sha256")
      .update(JSON.stringify(sort(v)))
      .digest("hex");
  f.store.beginEvent(click.eventId, hash(click), r.sessionId);
  f.controls.set(project.key, "active", {
    actor: "ou_owner",
    objective: "Inspect demo",
    maxSteps: 3,
    requestId: "card:" + hash(click.eventId),
  });
  let syncs = [];
  f.runtime.sync = async (args) => {
    syncs.push(args);
    return { ok: true };
  };
  const recovered = await f.controller.handle(click);
  assert.equal(f.controls.get(project.key).mode, "paused");
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].action, "pause");
  assert.ok(JSON.stringify(recovered.card).includes("暂停"));
  await f.controller.handle(click);
  assert.equal(syncs.length, 1);
});

test("an unsent new detail card cannot change what this project refers to", async (t) => {
  const f = fixture(t);
  f.store.verifyCallback(f.controller.scope);
  const first = await f.controller.prepare(
    { id: "om_a", requestId: "a", event: { sender_id: "ou_owner", chat_id: "oc_group" } },
    { ok: true, view: { kind: "project-status", project: { alias: projectAlias(project) } } },
  );
  f.controller.bind(first.sessionId, "om_a_card");
  assert.equal(f.store.context("ou_owner", "oc_group"), projectAlias(project));
  const other = { ...project, key: "codex:local:b", nativeId: "b", name: "Other" };
  f.controller.catalog.refresh = async () => ({ projects: [project, other], providers: [], complete: true });
  const unsent = await f.controller.prepare(
    { id: "om_b", requestId: "b", event: { sender_id: "ou_owner", chat_id: "oc_group" } },
    { ok: true, view: { kind: "project-status", project: { alias: projectAlias(other) } } },
  );
  assert.equal(f.store.get(unsent.sessionId).messageId, null);
  assert.equal(f.store.context("ou_owner", "oc_group"), projectAlias(project));
  f.controller.bind(unsent.sessionId, "om_b_card");
  assert.equal(f.store.context("ou_owner", "oc_group"), projectAlias(other));
  f.controller.bind(first.sessionId, "om_a_card");
  assert.equal(f.store.context("ou_owner", "oc_group"), projectAlias(other));
});

test("callback verification is bound to the configured profile, group and owner", (t) => {
  const f = fixture(t);
  f.store.verifyCallback(f.controller.scope);
  assert.equal(f.controller.enabled(), true);
  const other = new ProjectCardController(
    { ...config, profile: "another-bot" },
    { store: f.store, catalog: f.controller.catalog, controls: f.controls, runtime: f.runtime },
  );
  assert.equal(other.enabled(), false);
});

test("browsing and editing use the saved directory while confirmations refresh before execution", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const refresh = f.controller.catalog.refresh;
  f.controller.catalog.refresh = async () => {
    reads++;
    return refresh();
  };
  let r = await opened(f);
  assert.equal(reads, 1);
  r = await f.controller.handle(event(r, action(r, "probe")));
  assert.equal(reads, 1);
  r = await f.controller.handle(event(r, action(r, "detail")));
  assert.equal(reads, 1);
  r = await saveGoal(f, r);
  assert.equal(reads, 1);
  assert.equal(f.controls.get(project.key).mode, "manual");
  r = await f.controller.handle(event(r, action(r, "start")));
  assert.equal(reads, 2);
  r = await f.controller.handle(event(r, action(r, "confirm-start")));
  assert.equal(reads, 3);
  assert.equal(f.controls.get(project.key).mode, "active");
  f.controller.catalog.refresh = async () => {
    throw Error("offline must not block pause");
  };
  r = await f.controller.handle(event(r, action(r, "pause")));
  assert.equal(f.controls.get(project.key).mode, "paused");
  assert.ok(r.card);
});
test("a project removed before confirmation cannot be started from the cached directory", async (t) => {
  const f = fixture(t);
  let r = await saveGoal(f, await detailed(f));
  f.controller.catalog.refresh = async () => ({ complete: true, projects: [], providers: [] });
  r = await f.controller.handle(event(r, action(r, "start")));
  assert.equal(
    nodes(r.card).some((o) => o.behaviors?.[0]?.value.action === "confirm-start"),
    false,
  );
  assert.equal(f.controls.get(project.key).mode, "manual");
});

test("an initial query snapshot and a natural-language query each read the directory only once", async (t) => {
  const f = fixture(t);
  f.store.verifyCallback(f.controller.scope);
  let reads = 0;
  const refresh = f.controller.catalog.refresh;
  f.controller.catalog.refresh = async () => {
    reads++;
    return refresh();
  };
  const snapshot = await f.controller.catalog.refresh();
  await f.controller.prepare(
    { requestId: "strict", event: { sender_id: "ou_owner", chat_id: "oc_group" } },
    { ok: true, view: { kind: "project-directory" } },
    snapshot,
  );
  assert.equal(reads, 1);
  reads = 0;
  const result = await f.controller.natural(
    { requestId: "natural", event: { sender_id: "ou_owner", chat_id: "oc_group" } },
    "Demo现在怎样了",
  );
  assert.equal(reads, 1);
  assert.ok(result.response.card);
});
test("cached browsing never checks native readiness or fabricates a fresh read timestamp", async (t) => {
  const f = fixture(t);
  let r = await opened(f);
  const initial = f.store.get(r.sessionId).data.view.observedAt;
  f.controller.catalog.refresh = async () => {
    throw Error("unexpected native read");
  };
  f.runtime.readiness = async () => {
    throw Error("unexpected readiness check");
  };
  r = await f.controller.handle(event(r, action(r, "probe")));
  r = await f.controller.handle(event(r, action(r, "detail")));
  r = await saveGoal(f, r);
  assert.equal(f.store.get(r.sessionId).data.view.observedAt, initial);
  assert.equal(f.controls.get(project.key).mode, "manual");
});

test("project detail reads only its bounded activity and draft navigation does not reread it", async (t) => {
  const f = fixture(t);
  const calls = [];
  f.controller.activity = {
    read: async (key, options) => {
      calls.push({ key, options });
      return {
        status: "available",
        projectKey: key,
        observedAt: "2026-11-05T00:00:00Z",
        complete: true,
        selection: "latest-updated",
        works: [{ nativeId: "work-1", title: "Visible task", state: "unknown", membership: "native-project" }],
        selected: {
          nativeId: "work-1",
          title: "Visible task",
          state: "unknown",
          membership: "native-project",
          latestReply: {
            id: "reply-1",
            text: "Visible agent reply",
            at: null,
            phase: "final_answer",
            truncated: false,
          },
        },
      };
    },
  };
  let r = await detailed(f);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, project.key);
  assert.ok(JSON.stringify(r.card).includes("Visible agent reply"));
  r = await saveGoal(f, r);
  assert.equal(calls.length, 1);
  r = await f.controller.handle(event(r, action(r, "activity-refresh")));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.force, true);
  assert.equal(f.controls.get(project.key).mode, "manual");
});

test("an issued chat choice persists without starting work; a retained previous draft explicitly needs saving to the chosen chat", async (t) => {
  const f = fixture(t);
  const a = { threadId: "native-first", title: "原对话", updatedAt: "2026-11-06T01:00:00Z" };
  const b = { threadId: "native-second", title: "另一条工作线", updatedAt: "2026-11-06T02:00:00Z" };
  let choice = { ...a, revision: 0 };
  const selections = [];
  f.controller.bindings = {
    available: (k) => k === project.key,
    current: () => choice,
    list: async () => ({
      current: choice,
      revision: choice.revision,
      controlRevision: f.controls.get(project.key).revision,
      canChange: true,
      complete: true,
      items: [a, b],
    }),
    select: async (args) => {
      assert.deepEqual([args.threadId, args.expectedTitle, args.expectedRevision], [b.threadId, b.title, 0]);
      args.beforeMutation();
      selections.push(args);
      choice = { ...b, revision: 1 };
      return choice;
    },
  };
  let r = await detailed(f);
  r = await saveGoal(f, r);
  const saved = f.store.draft("ou_owner", "oc_group", projectAlias(project));
  assert.equal(saved.expectedThreadId, a.threadId);
  const oldStart = await f.controller.handle(event(r, action(r, "start")));
  // Open the picker through another legitimately bound card, leaving the old confirmation page in place.
  let current = await f.controller.create(
    { requestId: "second-card", event: { sender_id: "ou_owner", chat_id: "oc_group" } },
    { screen: "detail", alias: projectAlias(project) },
  );
  f.controller.bind(current.sessionId, "om_second");
  const call = (response, v) => event(response, v, { cardMessageId: "om_second" });
  current = await f.controller.handle(call(current, action(current, "open-chat-picker")));
  const choose = nodes(current.card)
    .map((n) => n.behaviors?.[0]?.value)
    .find((v) => v?.action === "preview-chat" && v.threadId === b.threadId);
  assert.ok(choose);
  assert.equal(selections.length, 0);
  await assert.rejects(f.controller.handle(call(current, { ...choose, action: "save-chat" })), {
    code: "CARD_ACTION_NOT_ISSUED",
  });
  current = await f.controller.handle(call(current, choose));
  const click = call(current, action(current, "save-chat"));
  const after = await f.controller.handle(click);
  assert.deepEqual(await f.controller.handle(click), after);
  assert.equal(selections.length, 1);
  assert.equal(f.controls.get(project.key).mode, "manual");
  assert.deepEqual(f.store.draft("ou_owner", "oc_group", projectAlias(project)), saved);
  assert.ok(!nodes(after.card).some((n) => n.behaviors?.[0]?.value.action === "start"));
  await f.controller.handle(event(oldStart, action(oldStart, "confirm-start")));
  assert.equal(f.controls.get(project.key).mode, "manual");
});

test("a suggested objective is private to the issued picker and replaces an old draft only after the owner saves the form; the start pins that chat", async (t) => {
  const f = fixture(t);
  await probed(f);
  const alias = projectAlias(project),
    a = { threadId: "thread-A", title: "原对话", revision: 0 };
  f.controller.bindings = {
    available: (k) => k === project.key,
    current: () => a,
    list: async () => ({ current: a, revision: 0, controlRevision: 0, complete: true, canChange: true, items: [a] }),
  };
  f.store.saveDraft("ou_owner", "oc_group", alias, { objective: "上次的草稿", maxSteps: 1 });
  const old = f.store.draft("ou_owner", "oc_group", alias);
  let r = await f.controller.create(
    { requestId: "picker-with-suggestion", event: { sender_id: "ou_owner", chat_id: "oc_group" } },
    { screen: "chat-picker", alias },
    undefined,
    { objective: "梳理完整导航", maxSteps: 3 },
  );
  f.controller.bind(r.sessionId, "om_suggestion");
  const click = (r, id) => event(r, action(r, id), { cardMessageId: "om_suggestion" });
  assert.deepEqual(f.store.draft("ou_owner", "oc_group", alias), old);
  r = await f.controller.handle(click(r, "detail"));
  r = await f.controller.handle(click(r, "use-goal-suggestion"));
  const input = nodes(r.card).find((n) => n.tag === "input");
  assert.equal(input.default_value, "梳理完整导航");
  assert.deepEqual(f.store.draft("ou_owner", "oc_group", alias), old);
  const submit = nodes(r.card).find((n) => n.form_action_type === "submit");
  r = await f.controller.handle(
    event(
      r,
      {},
      {
        cardMessageId: "om_suggestion",
        actionName: submit.name,
        formValue: JSON.stringify({ objective: "梳理完整导航", max_steps: "3" }),
      },
    ),
  );
  assert.equal(f.store.draft("ou_owner", "oc_group", alias).expectedThreadId, a.threadId);
  assert.equal(f.controls.get(project.key).mode, "manual");
  r = await f.controller.handle(click(r, "start"));
  r = await f.controller.handle(click(r, "confirm-start"));
  assert.equal(f.controls.get(project.key).mode, "active");
  assert.equal(f.controls.get(project.key).expectedThreadId, a.threadId);
});

test("owner can request a working chat card without remembering any title; opening it does not start or select", async (t) => {
  const f = fixture(t);
  f.store.verifyCallback(f.controller.scope);
  const c = { threadId: "33333333-3333-3333-3333-333333333333", title: "最近工作", revision: 0 };
  f.controller.bindings = {
    available: (key) => key === project.key,
    current: () => c,
    list: async () => ({ items: [c], current: c, complete: true, canChange: true, revision: 0 }),
  };
  const res = await f.controller.natural(
    { requestId: "get-picker", event: { sender_id: "ou_owner", chat_id: "oc_group" } },
    "选对话",
  );
  assert.equal(f.store.get(res.response.sessionId).data.navigation.screen, "chat-picker");
  assert.ok(JSON.stringify(res.response.card).includes(c.title));
  assert.equal(f.controls.get(project.key).mode, "manual");
});
