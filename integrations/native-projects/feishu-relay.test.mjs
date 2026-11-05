import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RelayQueue } from "./relay-queue.mjs";
import { LoopControls } from "./controls.mjs";
import { FeishuLoopRelay, commandText, acceptsCommand, larkReply, projectReply } from "./feishu-relay.mjs";

const config = {
  chatId: "oc_group",
  allowedSenderIds: ["ou_owner"],
  profile: "bot",
  queuePath: "",
  maxReplyAttempts: 3,
};
const event = (id, content, extra = {}) => ({
  message_id: id,
  chat_id: "oc_group",
  sender_id: "ou_owner",
  sender_type: "user",
  message_type: "text",
  content,
  ...extra,
});
test("only an explicit command from the configured group and owner is accepted", () => {
  assert.equal(acceptsCommand(event("om_1", "/loop 项目"), config), true);
  assert.equal(acceptsCommand(event("om_1", "普通聊天"), config), false);
  assert.equal(acceptsCommand(event("om_1", "/loop 项目", { sender_id: "ou_other" }), config), false);
  assert.equal(acceptsCommand(event("om_1", "/loop 项目", { chat_id: "oc_other" }), config), false);
  assert.equal(acceptsCommand(event("om_1", "/loop 项目", { sender_type: "app" }), config), false);
  assert.equal(commandText(event("om_1", "@_user_1 /loop 项目", { mentions: [{ key: "@_user_1" }] })), "/loop 项目");
});
test("a failed reply retries with the same key without redoing a mode change", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "loop-relay-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queuePath = path.join(directory, "queue.ndjson");
  writeFileSync(queuePath, "");
  const queue = new RelayQueue(path.join(directory, "queue.db"));
  const controls = new LoopControls(path.join(directory, "modes.json"));
  const project = {
    key: "codex:local:p",
    provider: "codex",
    host: "local",
    nativeId: "p",
    name: "Demo",
    capabilities: { read: true, continue: false },
  };
  let reads = 0;
  const catalog = {
    refresh: async () => {
      reads++;
      return { projects: [project], providers: [], complete: true };
    },
  };
  const sends = [];
  let failures = 1;
  const relay = new FeishuLoopRelay(
    { ...config, queuePath, retryMs: 0 },
    {
      queue,
      controls,
      catalog,
      reply: async (item) => {
        sends.push(item.deliveryKey);
        if (failures-- > 0) throw Object.assign(new Error(), { code: "REPLY_TIMEOUT" });
        return "om_reply";
      },
    },
  );
  t.after(() => queue.close());
  await relay.tick();
  appendFileSync(queuePath, JSON.stringify(event("om_1", "/loop 暂停 codex:local:p")) + "\n");
  await relay.tick();
  assert.equal(controls.get(project.key).mode, "paused");
  assert.equal(controls.get(project.key).revision, 1);
  await relay.tick();
  assert.equal(controls.get(project.key).revision, 1);
  assert.equal(reads, 1);
  assert.equal(sends[0], sends[1]);
  assert.equal(queue.get("om_1").state, "replied");
});
test("old messages and edited commands do not get replayed as new actions", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "loop-relay-edit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queuePath = path.join(directory, "queue.ndjson");
  writeFileSync(queuePath, JSON.stringify(event("om_old", "/loop 项目")) + "\n");
  const queue = new RelayQueue(path.join(directory, "queue.db"));
  t.after(() => queue.close());
  let calls = 0;
  const catalog = {
    refresh: async () => {
      calls++;
      return { projects: [], providers: [], complete: true };
    },
  };
  const relay = new FeishuLoopRelay(
    { ...config, queuePath },
    { queue, controls: new LoopControls(path.join(directory, "modes.json")), catalog, reply: async () => "om_reply" },
  );
  await relay.tick();
  assert.equal(calls, 0);
  appendFileSync(queuePath, JSON.stringify(event("om_new", "/loop 项目")) + "\n");
  await relay.tick();
  appendFileSync(queuePath, JSON.stringify(event("om_new", "/loop 启用 malicious | new goal")) + "\n");
  await relay.tick();
  assert.equal(calls, 1);
  assert.equal(queue.stats().replied, 1);
});
test("the publisher fixes bot identity and message target and sends literal content over stdin", async () => {
  const calls = [];
  const response = await larkReply(
    config,
    { id: "om_source", deliveryKey: "plr_1", event: event("om_source", "/loop 项目"), response: "literal $(text)" },
    async (program, args, options) => {
      calls.push({ program, args, input: options.input });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, data: { message_id: "om_reply", chat_id: "oc_group" } }),
      };
    },
  );
  assert.equal(response, "om_reply");
  assert.equal(calls[0].input, "literal $(text)");
  assert.deepEqual(calls[0].args.slice(-4), ["--as", "bot", "--text", "-"]);
  assert.ok(calls[0].args.includes("om_source"));
});

test("an original and edited command in the same batch cannot block a later pause", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "loop-batch-edit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queuePath = path.join(directory, "queue.ndjson");
  writeFileSync(queuePath, "");
  const queue = new RelayQueue(path.join(directory, "queue.db"));
  t.after(() => queue.close());
  const controls = new LoopControls(path.join(directory, "modes.json"));
  controls.set("codex:local:p", "active", { actor: "owner", objective: "Task", maxSteps: 3 });
  const catalog = { refresh: async () => ({ projects: [], providers: [], complete: true }) };
  const relay = new FeishuLoopRelay(
    { ...config, queuePath },
    { queue, controls, catalog, reply: async (item) => "om_reply_" + item.id },
  );
  await relay.tick();
  appendFileSync(
    queuePath,
    [event("om_first", "/loop 项目"), event("om_first", "/loop other"), event("om_pause", "/loop 暂停 codex:local:p")]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  await relay.tick();
  assert.equal(controls.get("codex:local:p").mode, "paused");
  assert.equal(queue.stats().replied, 2);
});

test("exhausted replies and revoked commands cannot starve newer valid replies", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "loop-reply-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queuePath = path.join(directory, "queue.ndjson");
  writeFileSync(queuePath, "");
  const queue = new RelayQueue(path.join(directory, "queue.db"));
  t.after(() => queue.close());
  const controls = new LoopControls(path.join(directory, "modes.json"));
  const catalog = { refresh: async () => ({ projects: [], providers: [], complete: true }) };
  let working = false,
    sends = 0;
  const relay = new FeishuLoopRelay(
    { ...config, queuePath, retryMs: 0 },
    {
      queue,
      controls,
      catalog,
      reply: async (item) => {
        sends++;
        if (!working) throw new Error("offline");
        return "om_sent_" + item.id;
      },
    },
  );
  await relay.tick();
  appendFileSync(
    queuePath,
    Array.from({ length: 11 }, (_, i) => JSON.stringify(event("om_" + i, "/loop 项目"))).join("\n") + "\n",
  );
  await relay.tick();
  await relay.tick();
  await relay.tick();
  assert.equal(queue.stats().reply_failed, 10);
  working = true;
  await relay.tick();
  assert.equal(queue.get("om_10").state, "replied");
  assert.equal(sends, 31);
});

test("verified display-name mentions and already-compacted text keep the command prefix", () => {
  assert.equal(
    commandText(event("om_1", "@Example Bot /loop 项目", { mentions: [{ key: "@_user_1", name: "Example Bot" }] })),
    "/loop 项目",
  );
  assert.equal(
    commandText(event("om_1", "/loop 项目", { mentions: [{ key: "@_user_1", name: "Example Bot" }] })),
    "/loop 项目",
  );
  assert.equal(
    commandText(event("om_1", "@A @B /loop 项目", { mentions: [{ name: "B" }, { name: "A" }] })),
    "/loop 项目",
  );
  assert.equal(
    commandText(event("om_1", "@Example BotOther /loop 项目", { mentions: [{ name: "Example Bot" }] })),
    "@Example BotOther /loop 项目",
  );
});

// A saved card must retry identically without rerunning a query or changing project control.
test("a native project card is fixed before delivery and uses interactive stdin", async () => {
  const result = {
    ok: true,
    text: "legacy",
    view: {
      kind: "project-directory",
      complete: true,
      providers: [{ provider: "codex", status: "connected", complete: true }],
      projects: [
        {
          alias: "C-1234567890",
          name: "Mobile project",
          provider: "codex",
          mode: "manual",
          execution: "read-only",
          revision: 0,
        },
      ],
    },
  };
  const response = projectReply(result, { projectCards: { enabled: true } });
  assert.equal(response.type, "interactive");
  assert.equal(response.card.schema, "2.0");
  assert.equal(JSON.stringify(response).includes('"callback"'), false);
  assert.equal(projectReply(result, {}), "legacy");
  assert.equal(projectReply({ ok: false, text: "error" }, { projectCards: { enabled: true } }), "error");
  const calls = [];
  const item = { id: "om_source", deliveryKey: "plr_card", event: event("om_source", "/loop 项目"), response };
  for (let n = 0; n < 2; n++)
    await larkReply(config, item, async (program, args, options) => {
      calls.push({ args, input: options.input });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, data: { message_id: "om_card", chat_id: "oc_group" } }),
      };
    });
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0].args.slice(-6), ["--as", "bot", "--msg-type", "interactive", "--content", "-"]);
  assert.deepEqual(JSON.parse(calls[0].input), response.card);
});
test("card publication rejects malformed, oversized and cross-group responses", async () => {
  const item = { id: "om_source", deliveryKey: "plr_card", event: event("om_source", "/loop 项目") };
  let writes = 0;
  const execute = async () => {
    writes++;
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: { message_id: "om_card", chat_id: "oc_other" } }) };
  };
  for (const response of [
    { type: "interactive", card: { schema: "1.0" } },
    { type: "interactive", card: { schema: "2.0", body: { elements: [] }, extra: "x".repeat(30000) } },
    { type: "other", card: {} },
  ])
    await assert.rejects(larkReply(config, { ...item, response }, execute), { code: "INVALID_REPLY" });
  assert.equal(writes, 0);
  const response = { type: "interactive", card: { schema: "2.0", body: { elements: [] } } };
  await assert.rejects(larkReply(config, { ...item, response }, execute), { code: "REPLY_UNCONFIRMED" });
  assert.equal(writes, 1);
});
test("project-card retries preserve the saved view and never activate a project", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "loop-card-retry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queuePath = path.join(directory, "events.ndjson");
  writeFileSync(queuePath, "");
  const queue = new RelayQueue(path.join(directory, "queue.db"));
  t.after(() => queue.close());
  const controls = new LoopControls(path.join(directory, "modes.json"));
  let reads = 0;
  const p = {
    key: "codex:local:p",
    provider: "codex",
    host: "local",
    nativeId: "p",
    name: "First name",
    capabilities: { read: true, continue: false },
  };
  const catalog = {
    refresh: async () => {
      reads++;
      return { projects: [p], providers: [], complete: true };
    },
  };
  const responses = [];
  let fails = true;
  const relay = new FeishuLoopRelay(
    { ...config, queuePath, retryMs: 0, projectCards: { enabled: true } },
    {
      queue,
      controls,
      catalog,
      reply: async (item) => {
        responses.push(item.response);
        if (fails) throw new Error("offline");
        return "om_card";
      },
    },
  );
  await relay.tick();
  appendFileSync(queuePath, JSON.stringify(event("om_card_query", "/loop 项目")) + "\n");
  await relay.tick();
  assert.equal(queue.get("om_card_query").response.type, "interactive");
  p.name = "Changed after saved response";
  fails = false;
  await relay.tick();
  assert.deepEqual(responses[0], responses[1]);
  assert.equal(reads, 1);
  assert.equal(controls.get(p.key).mode, "manual");
  assert.equal(queue.get("om_card_query").state, "replied");
});

test("owner natural language is handled by cards once and its delivery is bound before acknowledgement", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "natural-relay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, "queue.ndjson");
  writeFileSync(queuePath, "");
  const routing = path.join(dir, "routing.json");
  writeFileSync(
    routing,
    JSON.stringify({
      enabled: true,
      chatId: "oc_group",
      allowedSenderIds: ["ou_owner"],
      botMentionIds: ["ou_bot"],
      projectNames: ["Demo"],
    }),
  );
  const queue = new RelayQueue(path.join(dir, "queue.db"));
  t.after(() => queue.close());
  let calls = 0;
  const bound = [];
  const cards = {
    natural: async () => {
      calls++;
      return {
        ok: true,
        response: { type: "interactive", sessionId: "s", card: { schema: "2.0", body: { elements: [] } } },
      };
    },
    prepare: async () => null,
    bind: (id, ref) => bound.push([id, ref]),
  };
  const relay = new FeishuLoopRelay(
    { ...config, queuePath, naturalRoutingFile: routing },
    { queue, catalog: {}, controls: {}, cards, reply: async () => "om_response" },
  );
  await relay.tick();
  appendFileSync(
    queuePath,
    JSON.stringify(event("om_natural", "Demo现在怎样了", { mentions: [{ id: "ou_bot", name: "Bot" }] })) + "\n",
  );
  await relay.tick();
  await relay.tick();
  assert.equal(calls, 1);
  assert.deepEqual(bound, [["s", "om_response"]]);
  assert.equal(queue.get("om_natural").state, "replied");
});
