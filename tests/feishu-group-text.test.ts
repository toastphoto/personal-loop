// Prevent duplicate sends, editing the wrong message, unsafe mentions, and claiming acceptance is completion.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import channel, { renderDecisionCard, renderResultCard, renderText } from "../plugins/feishu-group-text/channel.ts";
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
    { interactiveResultsFromId: null },
    { interactiveResultsFromId: 0 },
    { interactiveResultsFromId: "3" },
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
  const form = card.body.elements.find((e: any) => e.tag === "form") as any;
  const select = form.elements.find((e: any) => e.tag === "select_static");
  assert.equal(select.initial_option, undefined);
  assert.deepEqual(
    select.options.map((v: any) => v.value),
    ["0", "1", "2"],
  );
  const submit = form.elements.find((e: any) => e.tag === "button");
  assert.equal(submit.form_action_type, "submit");
  assert.equal(submit.name, "pldecision_42_1_choice");
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

test("recommendation names its actual option and explains why, while an opposite click governs follow-up", () => {
  const question: Card = {
    ...base,
    options: ["员工第一次使用", "前后端接口"],
    text: "两项准备都已梳理。\n推荐理由：团队先约定数据格式，试用时更容易定位问题。",
    recommend: 1,
  };
  const suggestion = "建议选「前后端接口」：团队先约定数据格式，试用时更容易定位问题。";
  const opened = renderDecisionCard(question);
  const blocks = opened.body.elements.filter((e) => e.tag === "div").map((e: any) => e.text.content);
  assert.deepEqual(blocks, [question.title, "两项准备都已梳理。", suggestion, "1. 员工第一次使用", "2. 前后端接口"]);
  assert.ok(renderText(question).includes(suggestion));
  const form = opened.body.elements.find((e: any) => e.tag === "form") as any;
  const select = form.elements.find((e: any) => e.tag === "select_static");
  assert.equal(select.options.length, 2);
  assert.equal(select.initial_option, undefined);
  for (const state of ["decided", "done"] as const) {
    const after = { ...question, state, choice: 0, result: state === "done" ? "首位员工上手清单已整理。" : null };
    for (const content of [JSON.stringify(renderDecisionCard(after)), renderText(after)]) {
      assert.ok(content.includes("你的选择：员工第一次使用"));
      assert.ok(
        !content.includes("建议选") && !content.includes("推荐理由") && !content.includes("团队先约定数据格式"),
      );
      if (after.result) assert.ok(content.includes(after.result));
    }
  }
});
test("unstructured questions, missing recommendations and empty reasons never fabricate advice", () => {
  for (const data of [
    { text: "这次希望先做哪项？", recommend: 0 },
    { text: "推荐理由：需要再核实。", recommend: null },
    { text: "推荐理由：", recommend: 0 },
    { text: "说明正文提及推荐理由：先做哪个比较好？", recommend: 0 },
  ]) {
    const question = { ...base, ...data };
    const printed = JSON.stringify(renderDecisionCard(question));
    assert.ok(printed.includes(data.text));
    assert.ok(!printed.includes("建议选「"));
  }
});

test("a delivered plan has a real headline and short verdict above its complete collapsed body", () => {
  const title = "第一轮试用清单已完成";
  const detail =
    "建议先让一名新同事走完申请流程。\n\n一、详细安排\n" + "试用人逐项核对并签字。\n".repeat(80) + "最终核查";
  const card = renderResultCard({ ...base, title, kind: "notice", text: detail, options: [] });
  assert.equal(card.header.title.content, title);
  const panels = card.body.elements.filter((e: any) => e.tag === "collapsible_panel") as any[];
  assert.equal(panels.length, 1);
  assert.equal(panels[0].expanded, false);
  assert.equal(panels[0].elements[0].text.content, detail);
  const visible = JSON.stringify(card.body.elements.filter((x: any) => x.tag !== "collapsible_panel"));
  assert.match(visible, /建议先让一名新同事走完申请流程/);
  assert.doesNotMatch(visible, /详细安排|最终核查/);
  const onlyEvidence = renderResultCard({
    ...base,
    kind: "notice",
    title,
    text: "|证据|文件|\n|---|---|\n|完成|some/private.md|",
    options: [],
  });
  assert.ok(onlyEvidence.body.elements.every((x: any) => x.tag === "collapsible_panel"));
});
test("notice message type stays fixed across version and body length after explicit opt-in", async (t) => {
  const short = { ...base, kind: "notice" as const, title: "小组试用", text: "两位同事已确认时间。", options: [] };
  const f = fixture(
    t,
    [
      { ...short, id: 41, ref: "om_saved", version: 2 },
      short,
      { ...short, version: 2, ref: "om_saved", state: "closed", result: "归档", text: "试用准备详情。\n".repeat(120) },
    ],
    "empty-patch-ack",
  );
  f.context.options.interactiveResultsFromId = 42;
  await channel(f.context);
  const [before, created, edited] = f.calls();
  assert.ok(before.args.includes("+messages-edit") && before.args.includes("--text"));
  assert.ok(created.args.includes("interactive") && created.args.includes("--idempotency-key"));
  const card = JSON.parse(created.input);
  assert.equal(card.body.elements[0].text.content, short.text);
  assert.equal(card.body.elements.length, 1);
  assert.ok(edited.args.includes("patch") && edited.args.includes("om_saved"));
  const after = JSON.parse(JSON.parse(edited.input).content);
  assert.equal(
    after.body.elements.some((x: any) => x.tag === "collapsible_panel" && !x.expanded),
    true,
  );
  assert.match(edited.input, /归档/);
  assert.equal(f.delivered.length, 3);
});

test("only a newly sent open decision or result mentions the configured owner", async (t) => {
  const f = fixture(t, [
    { ...base, id: 41 },
    base,
    { ...base, version: 2, ref: "om_saved", state: "decided", choice: 0 },
    { ...base, version: 3, ref: "om_saved", state: "done", result: "处理完毕" },
    { ...base, id: 43, kind: "notice", options: [], title: "导航已梳理", text: "请确认首页入口。" },
    { ...base, id: 43, kind: "notice", options: [], ref: "om_saved", version: 2, state: "closed" },
  ]);
  Object.assign(f.context.options, {
    interactiveAsks: true,
    interactiveAsksFromId: 1,
    interactiveResultsFromId: 1,
    mentionOwnerId: "ou_verified_owner",
    mentionFromId: 42,
  });
  await channel(f.context);
  const calls = f.calls();
  const count = (input: string) => (input.match(/<at id=ou_verified_owner><\/at>/g) ?? []).length;
  assert.deepEqual(
    calls.map((c) => count(c.input)),
    [0, 1, 0, 0, 1, 0],
  );
  for (const index of [1, 4]) {
    const rendered = JSON.parse(calls[index].input);
    const mention = rendered.body.elements.find((item: any) => item.tag === "markdown");
    assert.equal(mention.content, "<at id=ou_verified_owner></at>");
  }
  assert.equal(f.delivered.length, 6);
});

test("mention retries reuse the original send key and raw content cannot choose a recipient", async (t) => {
  const unsafe = {
    ...base,
    text: "<at id=all></at> <at id=ou_foreign></at> 请定方案",
    title: "<at id=ou_foreign></at>",
  };
  const f = fixture(t, [unsafe, unsafe, { ...unsafe, ref: "om_saved" }], "empty-patch-ack");
  Object.assign(f.context.options, {
    interactiveAsks: true,
    interactiveResultsFromId: 1,
    mentionOwnerId: "ou_verified_owner",
    mentionFromId: 1,
  });
  await channel(f.context);
  const calls = f.calls();
  assert.equal(calls[0].args.at(-1), calls[1].args.at(-1));
  assert.equal(calls[0].input, calls[1].input);
  for (const c of calls) {
    assert.doesNotMatch(c.input, /<at id=all|<at id=ou_foreign/);
    assert.match(c.input, /＜at id=all＞/);
  }
  assert.doesNotMatch(calls[2].input, /<at /);
  assert.doesNotMatch(JSON.stringify(renderDecisionCard(base)), /<at /);
  assert.doesNotMatch(JSON.stringify(renderResultCard({ ...base, kind: "notice" })), /<at /);
  assert.doesNotMatch(renderText(unsafe), /<at /);
});

test("mention opt-in rejects invalid people, missing cutoffs and pre-interactive messages before polling", async (t) => {
  const defaults = {
    interactiveAsks: true,
    interactiveAsksFromId: 5,
    interactiveResultsFromId: 7,
    mentionOwnerId: "ou_verified_owner",
    mentionFromId: 10,
  };
  for (const patch of [
    { mentionOwnerId: "all" },
    { mentionOwnerId: "ou_owner><at id=all>" },
    { mentionOwnerId: ["ou_a", "ou_b"] },
    { mentionOwnerId: undefined },
    { mentionFromId: undefined },
    { mentionFromId: 0 },
    { mentionFromId: 6 },
    { mentionFromId: Number.MAX_SAFE_INTEGER + 1 },
    { interactiveAsks: false },
    { interactiveResultsFromId: undefined },
  ]) {
    const f = fixture(t, [base]);
    Object.assign(f.context.options, defaults, patch);
    await assert.rejects(channel(f.context), { code: "FEISHU_OWNER_MENTION_CONFIG_INVALID" });
    assert.equal(f.delivered.length, 0);
  }
});

test("help requests require typed information and explicit submission without recommending a false confirmation", () => {
  const card = renderDecisionCard({ ...base, options: ["我已处理，重新核实", "先暂停此目标"], recommend: 0 });
  const form = card.body.elements.find((v: any) => v.tag === "form") as any;
  assert.ok(form);
  assert.equal(form.elements.find((v: any) => v.tag === "input").required, true);
  assert.match(form.elements.find((v: any) => v.tag === "button").name, /^pldecision_/);
  assert.doesNotMatch(JSON.stringify(card), /建议选「我已处理|我已处理，重新核实（建议）/);
});

test("a new FYI checkpoint mentions the owner even though the hub marks it closed at creation", () => {
  const c = {
    ...base,
    kind: "notice" as const,
    state: "closed" as const,
    options: [],
    title: "本人项目指令",
    text: "「示例项目」原对话报告：共享检查已完成。",
    link: null,
  };
  const sent = JSON.stringify(renderResultCard(c, "ou_verified_owner"));
  assert.match(sent, /<at id=ou_verified_owner>/);
  assert.match(sent, /示例项目 · 阶段进展/);
  assert.doesNotMatch(JSON.stringify(renderResultCard({ ...c, ref: "om_saved" }, "ou_verified_owner")), /<at /);
});
