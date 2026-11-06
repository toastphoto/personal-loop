// Prevent duplicate sends, editing the wrong message, unsafe mentions, and claiming acceptance is completion.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import channel, { renderText } from "../plugins/feishu-group-text/channel.ts";
import type { Card, ChannelContext } from "../host/channels.ts";

const base: Card = {
  id: 42,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "选择下一步",
  text: "请决定处理方式",
  options: ["继续", "暂停"],
  recommend: 1,
  choice: null,
  answer: null,
  result: null,
  link: "https://hub.test/c/private-capability",
};
function fixture(t: { after: (fn: () => void) => void }, cards: Card[], mode = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "feishu-group-text-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, "calls.jsonl"),
    program = join(dir, "fake-lark");
  writeFileSync(
    program,
    `#!${process.execPath}
import('node:fs').then(async fs => {
  let input=''; for await (const chunk of process.stdin) input+=chunk;
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2),input})+'\\n');
  const mode=${JSON.stringify(mode)};
  if(mode==='fail'){ process.stderr.write('PRIVATE_ERROR_WITH_ACCESS_TOKEN'); process.exit(1); }
  if(mode==='invalid'){ console.log('PRIVATE_INVALID_RESPONSE'); return; }
  if(mode==='not-ok'){ console.log(JSON.stringify({ok:false,error:{message:'PRIVATE_ERROR'}})); return; }
  if(mode==='missing-id'){ console.log(JSON.stringify({ok:true,data:{}})); return; }
  const args=process.argv.slice(2), chatIndex=args.indexOf('--chat-id');
  if(mode==='empty-patch-ack' && args.includes('patch')){ console.log(JSON.stringify({ok:true,data:{}})); return; }
  const chatId=chatIndex<0?'oc_group':args[chatIndex+1];
  console.log(JSON.stringify({ok:true,data:{message_id: mode==='mismatch'?'om_other':'om_saved',chat_id:mode==='chat-mismatch'?'oc_wrong':chatId}}));
});
`,
    { mode: 0o755 },
  );
  const stop = new AbortController(),
    delivered: unknown[][] = [],
    failed: unknown[][] = [],
    logs: string[] = [];
  const hub = {
    async nextCard() {
      const card = cards.shift() ?? null;
      if (!card) stop.abort();
      return { card };
    },
    async delivered(...args: unknown[]) {
      delivered.push(args);
    },
    async failed(...args: unknown[]) {
      failed.push(args);
    },
    async answer() {},
  };
  const context: ChannelContext = {
    hub,
    options: { profile: "my-profile", chatId: "oc_group", deliveryNamespace: "test-hub", lark: program },
    log: (text) => logs.push(text),
    signal: stop.signal,
  };
  return {
    context,
    stop,
    delivered,
    failed,
    logs,
    calls: () =>
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

test("open questions show one-based choices, and later states never ask again", () => {
  const open = renderText(base);
  assert.match(open, /1[.、] 继续/);
  assert.match(open, /2[.、] 暂停/);
  assert.match(open, /\/loop 回答 42 1/);
  assert.ok(!open.includes(base.link!));
  const decided = renderText({ ...base, state: "decided", choice: 1 });
  assert.match(decided, /等待处理/);
  assert.ok(!decided.includes("已完成"));
  assert.ok(!decided.includes("/loop 回答"));
  for (const state of ["done", "closed"] as const) {
    const text = renderText({ ...base, state, result: "原生回执：仍在运行" });
    assert.match(text, /原生回执：仍在运行/);
    assert.ok(!text.includes("/loop 回答"));
  }
  const notice = renderText({ ...base, kind: "notice", options: [] });
  assert.match(notice, /无需回复/);
  assert.ok(!notice.includes("/loop 回答"));
});

test("mentions become literal full-width text and authorization links are omitted", () => {
  const rendered = renderText({
    ...base,
    title: '<at user_id="all">所有人</at>',
    text: base.link!,
    options: ["<at>name</at>", "safe"],
    result: base.link,
  });
  assert.ok(!rendered.includes("<"));
  assert.ok(!rendered.includes(">"));
  assert.ok(rendered.includes("＜at"));
  assert.ok(!rendered.includes("private-capability"));
});

test("new text uses stable idempotency and later versions edit the original message", async (t) => {
  const f = fixture(t, [
    base,
    { ...base, version: 2, ref: "om_saved", state: "decided", choice: 1 },
    { ...base, version: 3, ref: "om_saved", state: "done", result: "已核实" },
  ]);
  await channel(f.context);
  const calls = f.calls();
  assert.equal(calls.length, 3);
  const key = calls[0].args.at(-1);
  assert.match(key, /^pl-card-[a-f0-9]{20}-42$/);
  assert.deepEqual(calls[0].args, [
    "--profile",
    "my-profile",
    "im",
    "+messages-send",
    "--chat-id",
    "oc_group",
    "--as",
    "bot",
    "--text",
    "-",
    "--idempotency-key",
    key,
  ]);
  for (const call of calls.slice(1))
    assert.deepEqual(call.args, [
      "--profile",
      "my-profile",
      "im",
      "+messages-edit",
      "--message-id",
      "om_saved",
      "--as",
      "bot",
      "--text",
      "-",
    ]);
  assert.deepEqual(f.delivered, [
    [42, 1, "om_saved"],
    [42, 2, "om_saved"],
    [42, 3, "om_saved"],
  ]);
  assert.deepEqual(f.failed, []);
  assert.ok(!JSON.stringify(calls).includes("event"));
});

test("re-delivery without an acknowledgement reuses the card ID, not its version", async (t) => {
  const f = fixture(t, [base, { ...base, version: 2 }]);
  await channel(f.context);
  assert.equal(f.calls()[0].args.at(-1), f.calls()[1].args.at(-1));
});

test("shell-looking card text only travels through stdin", async (t) => {
  const marker = join(tmpdir(), "never-created-by-group-text");
  const f = fixture(t, [{ ...base, text: `$(touch ${marker}); \`uname\` -n` }]);
  await channel(f.context);
  const call = f.calls()[0];
  assert.ok(call.input.includes("$(touch"));
  assert.ok(!call.args.some((x: string) => x.includes("touch")));
});

for (const mode of ["fail", "invalid", "not-ok", "missing-id"]) {
  test(`a ${mode} CLI response is reported without leaking its content`, async (t) => {
    const f = fixture(t, [base], mode);
    await channel(f.context);
    assert.equal(f.delivered.length, 0);
    assert.equal(f.failed.length, 1);
    assert.ok(!JSON.stringify([f.failed, f.logs]).includes("PRIVATE"));
  });
}

test("failed or mismatched edit is never replaced with a new send", async (t) => {
  const f = fixture(t, [{ ...base, ref: "om_saved" }], "mismatch");
  await channel(f.context);
  assert.equal(f.calls().length, 1);
  assert.ok(f.calls()[0].args.includes("+messages-edit"));
  assert.equal(f.delivered.length, 0);
  assert.equal(f.failed.length, 1);
});

test("required route configuration is rejected before reading cards", async (t) => {
  for (const patch of [
    { profile: "" },
    { chatId: "" },
    { deliveryNamespace: "" },
    { deliveryNamespace: undefined },
    { lark: "relative/script" },
    { interactiveAsks: "true" },
    { interactiveAsksFromId: 0 },
    { interactiveAsksFromId: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const f = fixture(t, [base]);
    f.context.options = { ...f.context.options, ...patch };
    await assert.rejects(channel(f.context));
    assert.equal(f.delivered.length, 0);
  }
});

test("an already aborted channel does not start the CLI", async (t) => {
  const f = fixture(t, [base]);
  f.stop.abort();
  await channel(f.context);
  assert.deepEqual(f.delivered, []);
  assert.deepEqual(f.failed, []);
});

test("delivery keys isolate both hub namespace and group and remain within the platform limit", async (t) => {
  const keys: string[] = [];
  for (const [deliveryNamespace, chatId] of [
    ["hub-one", "oc_group"],
    ["hub-two", "oc_group"],
    ["hub-one", "oc_other"],
  ]) {
    const f = fixture(t, [{ ...base, id: Number.MAX_SAFE_INTEGER }]);
    f.context.options = { ...f.context.options, deliveryNamespace, chatId };
    await channel(f.context);
    const key = f.calls()[0].args.at(-1);
    assert.ok(key.length <= 50);
    keys.push(key);
    assert.equal(f.delivered.length, 1);
  }
  assert.equal(new Set(keys).size, 3);
});

test("a foreign group in send or edit acknowledgement is rejected", async (t) => {
  for (const ref of [null, "om_saved"]) {
    const f = fixture(t, [{ ...base, ref }], "chat-mismatch");
    await channel(f.context);
    assert.equal(f.calls().length, 1);
    assert.equal(f.delivered.length, 0);
    assert.equal(f.failed.length, 1);
  }
});

test("opt-in decision sends identify each option, keep the full label and omit capability links", async (t) => {
  const prefix = "请检查同一个工作台首页的视觉方案".repeat(9);
  const options = [prefix + "甲", prefix + "乙", "只看现状"];
  const f = fixture(t, [{ ...base, title: "<at>全体</at>", text: base.link!, options }]);
  Object.assign(f.context.options, { interactiveAsks: true, interactiveAsksFromId: base.id });
  await channel(f.context);
  const [{ args, input }] = f.calls();
  assert.ok(args.includes("+messages-send") && args.includes("--content") && args.includes("interactive"));
  assert.match(args.at(-1), /^pl-card-[a-f0-9]{20}-42$/);
  assert.doesNotMatch(input, /private-capability|<at>|\/loop 回答|markdown/);
  const card = JSON.parse(input);
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.update_multi, true);
  assert.equal(card.config.enable_forward, false);
  for (const label of options) assert.ok(input.includes(label));
  const buttons = card.body.elements.filter((element: { tag: string }) => element.tag === "button");
  assert.deepEqual(
    buttons.map((b: any) => b.behaviors),
    options.map((_, choice) => [
      { type: "callback", value: { personalLoopDecision: 1, card: 42, choice, version: 1 } },
    ]),
  );
  assert.equal(new Set(buttons.map((b: any) => b.text.content)).size, 3);
  assert.ok(buttons.every((b: any) => b.text.content.length <= 100 && b.text.tag === "plain_text"));
  assert.match(buttons[1].text.content, /建议/);
});

test("decided, done and closed decision cards patch the original and remove the choices", async (t) => {
  const f = fixture(
    t,
    [
      { ...base, ref: "om_saved", version: 2, state: "decided", choice: 1 },
      { ...base, ref: "om_saved", version: 3, state: "done", choice: 1, result: "已按选择完成核对" },
      { ...base, ref: "om_saved", version: 4, state: "closed", result: "已取消此项" },
    ],
    "empty-patch-ack",
  );
  f.context.options.interactiveAsks = true;
  await channel(f.context);
  const calls = f.calls();
  assert.equal(calls.length, 3);
  for (const { args, input } of calls) {
    assert.deepEqual(args, [
      "--profile",
      "my-profile",
      "im",
      "messages",
      "patch",
      "--message-id",
      "om_saved",
      "--as",
      "bot",
      "--data",
      "-",
    ]);
    const card = JSON.parse(JSON.parse(input).content);
    assert.equal(card.schema, "2.0");
    assert.doesNotMatch(input, /personalLoopDecision|private-capability|"button"/);
  }
  assert.match(calls[0].input, /等待处理/);
  assert.match(calls[0].input, /你的选择：暂停/);
  assert.match(calls[1].input, /已按选择完成核对/);
  assert.match(calls[2].input, /已取消此项/);
  assert.deepEqual(f.delivered, [
    [42, 2, "om_saved"],
    [42, 3, "om_saved"],
    [42, 4, "om_saved"],
  ]);
});

test("cutover keeps earlier unsent questions, earlier edits and every notice on text", async (t) => {
  const f = fixture(t, [
    base,
    { ...base, ref: "om_saved", state: "decided", version: 2 },
    { ...base, id: 44, kind: "notice", options: [] },
  ]);
  Object.assign(f.context.options, { interactiveAsks: true, interactiveAsksFromId: 43 });
  await channel(f.context);
  assert.ok(f.calls().every((call) => call.args.includes("--text")));
  assert.equal(f.delivered.length, 3);
});
