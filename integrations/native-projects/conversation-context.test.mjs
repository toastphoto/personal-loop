// A reply must stay with its project even when another conversation recently finished in the same group.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { chmodSync, realpathSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { subjectFor } from "./controls.mjs";
import { DatabaseSync } from "node:sqlite";
import { conversationContext } from "./conversation-context.mjs";
const now = Date.now(),
  owner = "ou_owner",
  chat = "oc_group",
  first = "C-1111111111",
  second = "M-2222222222";
const cfg = { chatId: chat, profile: "fixture", allowedSenderIds: [owner] };
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE relay_messages(seq INTEGER PRIMARY KEY,id TEXT,sender TEXT,chat TEXT,event_json TEXT,result_json TEXT,response_json TEXT,delivery_ref TEXT,state TEXT,created_at INTEGER)",
  );
  const add = (
    id,
    {
      alias = first,
      to,
      root,
      topic,
      actor = owner,
      group = chat,
      delta = -1000,
      state = "replied",
      text = "上个问题",
      output = "处理摘要",
      ref = "om_bot_" + id,
      contextTopic,
    } = {},
  ) => {
    const event = {
      message_type: "text",
      sender_type: "user",
      chat_id: group,
      sender_id: actor,
      message_id: "om_" + id,
      create_time: String(now + delta),
      content: text,
      ...(to && { reply_to: to }),
      ...(root && { root_id: root }),
      ...(topic && { thread_id: topic }),
    };
    db.prepare(
      "insert into relay_messages(id,sender,chat,event_json,result_json,response_json,delivery_ref,state,created_at) values(?,?,?,?,?,?,?,?,?)",
    ).run(
      event.message_id,
      actor,
      group,
      JSON.stringify(event),
      JSON.stringify({
        ok: true,
        action: alias ? "status" : "conversation",
        ...(alias && { contextAlias: alias }),
        contextTopic,
      }),
      JSON.stringify(output),
      ref,
      state,
      now + delta,
    );
  };
  const get = (eventFields = {}, extra = {}, connection = cfg) =>
    conversationContext(
      {
        id: "om_current",
        event: {
          message_id: "om_current",
          sender_id: owner,
          chat_id: chat,
          sender_type: "user",
          message_type: "text",
          create_time: String(now),
          content: "它怎么样",
          ...eventFields,
        },
      },
      connection,
      { db },
      { now, ...extra },
    );
  return { add, get };
}
test("direct references to the delivered bot reply or original owner message select only that branch", (t) => {
  const f = fixture(t);
  f.add("a", { text: "先看 A", output: "A 已等确认", delta: -4000 });
  f.add("b", { alias: second, text: "谈 B", delta: -3000 });
  f.add("a2", { to: "om_bot_a", text: "A 的下一步", output: "再看 A", delta: -2000 });
  for (const ref of ["om_bot_a2", "om_a2"]) {
    const x = f.get({ reply_to: ref });
    assert.equal(x.basis, "reply");
    assert.equal(x.contextAlias, first);
    assert.deepEqual(
      x.history.map((v) => v.text),
      ["先看 A", "A 已等确认", "A 的下一步", "再看 A"],
    );
  }
  assert.equal(f.get().basis, "ambiguous");
  assert.deepEqual(f.get().history, []);
  assert.equal(f.get({ reply_to: "om_unknown", root_id: "om_a" }).basis, "none");
});

test("a reply to an automatically delivered image report retains its project without using another recent topic", (t) => {
  const f = fixture(t),
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "artifact-reply-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const key = "codex:local:company",
    target = { projectKey: key, root: "/project", threadId: "original", projectName: "公司项目" };
  const dir = path.join(root, "a".repeat(64));
  mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, "delivery.json");
  const state = {
    status: "delivered",
    messageId: "om_artifact",
    verifiedAt: new Date(now - 500).toISOString(),
    sendAttemptAt: now - 1500,
    source: { at: now - 2000 },
    destination: { profile: cfg.profile, chatId: chat, ownerId: owner },
    target,
    report: { title: "成果回源已修复", summary: "合成项目中回到正确所属项目" },
    readback: { message_id: "om_artifact", chat_id: chat, deleted: false },
  };
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const config = { ...cfg, artifactDelivery: { stateDir: root, targets: [target] } },
    nativeConfig = { managedCodex: { boundChats: { [key]: { threadId: "original", root: "/project" } } } };
  f.add("other", { alias: second });
  const got = f.get({ reply_to: "om_artifact" }, { nativeConfig }, config);
  assert.equal(got.basis, "reply");
  assert.match(got.contextAlias, /^C-/);
  assert.notEqual(got.contextAlias, second);
  assert(got.history[0].text.includes("成果回源"));
  state.status = "retry";
  writeFileSync(file, JSON.stringify(state));
  assert.equal(f.get({ reply_to: "om_artifact" }, { nativeConfig }, config).contextAlias, undefined);
});
test("explicit thread affinity, group/owner scoping and no future or stale recent carry-over", (t) => {
  const f = fixture(t);
  f.add("a", { topic: "omt_original", root: "om_root", text: "话题一", delta: -12000 });
  f.add("b", { topic: "omt_other", alias: second, text: "话题二", delta: -10000 });
  assert.equal(f.get({ thread_id: "omt_original" }).contextAlias, first);
  assert.equal(f.get({ root_id: "om_root" }).contextAlias, first);
  f.add("foreign", { actor: "ou_intruder", text: "PRIVATE" });
  f.add("othergroup", { group: "oc_other", text: "PRIVATE" });
  assert.equal(f.get({ reply_to: "om_foreign" }).basis, "none");
  assert.equal(f.get({ reply_to: "om_bot_othergroup" }).basis, "none");
  assert.equal(f.get({ sender_id: "ou_intruder", reply_to: "om_a" }).basis, "none");
  assert.equal(f.get({ thread_id: "omt_unknown" }).basis, "none");
  const g = fixture(t);
  g.add("old", { alias: second, delta: -86400000 });
  g.add("a", { text: "实问", output: "实答" });
  g.add("future", { alias: second, delta: 10000 });
  assert.equal(g.get().basis, "unique-recent");
  assert.equal(g.get().contextAlias, first);
  g.add("pending", { alias: second, state: "handled", ref: null, delta: -400 });
  assert.equal(g.get().basis, "ambiguous");
});
test("history is bounded, redacted and excludes unsigned card contents, unrelated prompts and URLs", (t) => {
  const f = fixture(t);
  f.add("a", {
    text: "看状态 https://test.example/private?token=bad",
    output: { type: "interactive", card: { body: { leak: "RAW_CARD_SECRET" } } },
  });
  const x = f.get({ reply_to: "om_bot_a" });
  assert.doesNotMatch(JSON.stringify(x), /https:|private\?|RAW_CARD_SECRET/);
  const g = fixture(t);
  g.add("s", { text: "abc".repeat(800), output: "Bearer " + "X".repeat(48) });
  assert.ok(JSON.stringify(g.get().history).length < 600);
  assert.doesNotMatch(JSON.stringify(g.get().history), /X{20}/);
});

test("a real group decision ref uses its matched native delivery, not another group or unconfirmed message", (t) => {
  const f = fixture(t);
  const dir = mkdtempSync(path.join(tmpdir(), "reply-hub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cf = path.join(dir, "config.json"),
    key = "codex:local:a";
  const nativeConfig = { loopHub: { configFile: cf } },
    controls = { list: () => [{ projectKey: key }] };
  writeFileSync(
    cf,
    JSON.stringify({ channels: { group: { use: "feishu-group-text", profile: "fixture", chatId: chat } } }),
  );
  const db = new DatabaseSync(path.join(dir, "hub.db"));
  db.exec("create table projections(collection text,key text,data text)");
  const put = (c, k, d) => db.prepare("insert into projections values(?,?,?)").run(c, k, JSON.stringify(d));
  put("cards", "7", {
    rule: "native-project:" + subjectFor(key),
    kind: "ask",
    created_at: new Date(now - 3000).toISOString(),
    title: "先做哪个？",
    options: JSON.stringify(["入口", "验收"]),
    text: "优先考虑试用准备",
  });
  put("deliveries", "7:group", { channel: "group", card_id: 7, ref: "om_question", version: 1 });
  db.close();
  const hit = f.get({ reply_to: "om_question" }, { nativeConfig, controls });
  assert.equal(hit.basis, "reply");
  assert.ok(hit.contextAlias.startsWith("C-"));
  assert.match(hit.history[0].text, /入口；验收/);
  writeFileSync(
    cf,
    JSON.stringify({ channels: { group: { use: "feishu-group-text", profile: "fixture", chatId: "oc_wrong" } } }),
  );
  assert.equal(f.get({ reply_to: "om_question" }, { nativeConfig, controls }).basis, "none");
});

test("proactive reply resolves only through its acknowledged private watcher scope and exact current binding", (t) => {
  const f = fixture(t),
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-notice-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cf = path.join(dir, "config.json"),
    rf = path.join(dir, "rules.json"),
    nativeFile = path.join(dir, "native.json"),
    relayFile = path.join(dir, "relay.json"),
    stateFile = path.join(dir, "watch.db");
  const key = "codex:local:a",
    threadId = "11111111-1111-1111-1111-111111111111",
    binding = { threadId, projectId: "a", root: path.join(dir, "project") };
  const opt = {
    enabled: true,
    enabledAt: new Date(now - 5000).toISOString(),
    targets: [{ projectKey: key, threadId, projectName: "同名项目" }],
    stateFile,
  };
  const nativeConfig = {
    version: 1,
    providers: { codex: { allowConversationPreview: true } },
    managedCodex: {
      enabled: true,
      stateDir: dir,
      coordinatorProjectKeys: [key],
      projectRoots: { [key]: binding.root },
      boundChats: { [key]: binding },
    },
    loopHub: { configFile: cf, rulesFile: rf },
  };
  writeFileSync(
    cf,
    JSON.stringify({
      source: { name: "native" },
      channels: { group: { use: "feishu-group-text", profile: cfg.profile, chatId: chat } },
    }),
  );
  writeFileSync(rf, JSON.stringify({ channels: { group: { answerers: [owner] } } }));
  const relay = { ...cfg, nativeConfigFile: nativeFile, proactiveNotices: opt };
  const save = () => {
    writeFileSync(nativeFile, JSON.stringify(nativeConfig));
    writeFileSync(relayFile, JSON.stringify(relay));
  };
  save();
  const id = "progress-" + "a".repeat(48);
  const hub = new DatabaseSync(path.join(dir, "hub.db"));
  hub.exec("create table projections(collection text,key text,data text)");
  const put = (table, k, d) => hub.prepare("insert into projections values(?,?,?)").run(table, k, JSON.stringify(d));
  put("cards", "4", {
    rule: null,
    kind: "notice",
    key: "source:native:" + id,
    fyi: true,
    version: 1,
    id: 4,
    created_at: new Date(now - 500).toISOString(),
    title: "应用",
    text: "「同名项目」原聊天有新交付。",
    options: "[]",
  });
  put("deliveries", "4:group", { channel: "group", card_id: 4, ref: "om_proactive", version: 1 });
  hub.close();
  const receipts = new DatabaseSync(stateFile);
  chmodSync(stateFile, 0o600);
  receipts.exec("create table notices(key text,card integer);create table notice_scopes(key text,scope text)");
  const scope = createHash("sha256")
    .update(JSON.stringify([cfg.profile, chat, opt.enabledAt, key, binding]))
    .digest("hex");
  receipts.prepare("insert into notices values(?,4)").run(id);
  const get = () =>
    f.get(
      { reply_to: "om_proactive" },
      { nativeConfig, configFile: relayFile, controls: { list: () => [{ projectKey: key }] } },
      relay,
    );
  assert.equal(get().basis, "none");
  receipts.prepare("insert into notice_scopes values(?,?)").run(id, scope);
  const valid = get();
  assert.equal(valid.basis, "reply");
  assert.match(valid.contextAlias, /^C-/);
  assert.match(valid.history[0].text, /新交付/);
  nativeConfig.managedCodex.boundChats[key] = { ...binding, threadId: "22222222-2222-2222-2222-222222222222" };
  save();
  assert.equal(get().basis, "none");
  nativeConfig.managedCodex.boundChats[key] = binding;
  opt.enabled = false;
  save();
  assert.equal(get().basis, "none");
  receipts.close();
});
