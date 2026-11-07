// An item can finish before its turn; only the exact original thread's public completed messages may cross this boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { readCheckpointItems, classifyCheckpoint } from "./checkpoint-source.mjs";
const key = "codex:local:project";
const tid = "11111111-1111-4111-8111-111111111111";
const config = {
  managedCodex: {
    enabled: true,
    stateDir: "/private/does-not-write",
    projectRoots: { [key]: "/project" },
    boundChats: { [key]: { threadId: tid, root: "/project", projectId: "project" } },
  },
};
const target = { projectKey: key, threadId: tid };
const at = Date.now();
function transport(entries) {
  return {
    connect: async () => {},
    request: async (method, args) => {
      if (method === "project/read") return { project: { id: "project", roots: [{ path: "/project" }] } };
      if (method === "thread/read") return { thread: { id: tid, cwd: "/project", projectId: "project" } };
      if (method === "thread/list") return { data: [{ id: tid, cwd: "/project", projectId: "project" }] };
      if (method === "thread/turns/list")
        return { data: [{ id: "turn", status: "interrupted", startedAt: (at - 1000) / 1000, completedAt: null }] };
      if (method === "thread/items/list") {
        assert.equal(args.threadId, tid);
        assert.equal(args.turnId, "turn");
        return { data: entries };
      }
      throw Error(method);
    },
  };
}
const row = (id, text, extra = {}) => ({
  turnId: "turn",
  completedAtMs: at,
  item: { id, type: "agentMessage", phase: "commentary", text, ...extra },
});
test("a completed public commentary is readable before turn completion; no tool or reasoning text returns", async () => {
  const rows = [
    row("stage", "保存和复用已经接上了，下一步检查换样。"),
    { turnId: "turn", item: { id: "r", type: "reasoning", content: ["PRIVATE_REASON"] } },
    {
      turnId: "turn",
      completedAtMs: at,
      item: { id: "t", type: "commandExecution", aggregatedOutput: "PRIVATE_TOOL" },
    },
    row("partial", "我还在输出", { completedAtMs: null }),
  ];
  rows[3].completedAtMs = null;
  const r = await readCheckpointItems(config, target, { since: at - 500, now: at + 500, client: transport(rows) });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].itemId, "stage");
  assert.equal(r.items[0].turnId, "turn");
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_/);
});
test("foreign turn items and future timestamps cannot authorize a notification", async () => {
  await assert.rejects(
    readCheckpointItems(config, target, {
      since: at - 500,
      now: at + 500,
      client: transport([{ ...row("x", "已完成入口。"), turnId: "foreign" }]),
    }),
  );
  const r = await readCheckpointItems(config, target, {
    since: at - 500,
    now: at,
    client: transport([{ ...row("x", "已完成入口。"), completedAtMs: at + 60000 }]),
  });
  assert.equal(r.items.length, 0);
});
test("semantic plans require a quotation grounded in the selected message and do not invent options or recommendations", async () => {
  const item = {
    itemId: "i",
    turnId: "t",
    at,
    phase: "commentary",
    text: "保存和复用已经接上了。下一步会做换样验证。",
  };
  const answer = {
    kind: "milestone",
    topic: "保存和复用",
    summary: "保存和复用已接好，接下来验证不同材料。",
    evidence: "保存和复用已经接上了。",
  };
  const good = await classifyCheckpoint(item, {
    run: async () => ({ text: JSON.stringify(answer) }),
    beforeStart: () => {},
  });
  assert.equal(good.kind, "milestone");
  assert.equal(
    await classifyCheckpoint(item, {
      run: async () => ({ text: JSON.stringify({ ...answer, evidence: "已经上线" }) }),
    }),
    null,
  );
  assert.equal(
    await classifyCheckpoint(item, {
      run: async () => ({ text: JSON.stringify({ ...answer, options: ["删除旧数据", "直接上线"] }) }),
    }),
    null,
  );
  const decision = {
    ...item,
    text: "导航已成形。请确认先看完整导航，还是先试卡片库？",
    questions: [{ title: "先看什么？", options: ["完整导航", "卡片库"] }],
  };
  const plan = {
    kind: "decision",
    topic: "导航",
    summary: "导航已成形，请选择先看哪部分。",
    evidence: "请确认先看完整导航，还是先试卡片库？",
    question: "先看什么？",
    options: ["完整导航", "卡片库"],
    recommend: 0,
    reason: "先看完整导航有助于确认范围。",
  };
  assert.equal(
    (await classifyCheckpoint(decision, { run: async () => ({ text: JSON.stringify(plan) }) })).options.length,
    2,
  );
  const bad = await classifyCheckpoint(decision, {
    run: async () => ({ text: JSON.stringify({ ...plan, options: ["安装全公司", "删除旧版"] }) }),
  });
  assert.equal(bad, null);
});

test("exact item anchors verify the source and complete following history in a long turn without assuming timestamp order", async () => {
  const prefix = Array.from({ length: 300 }, (_, i) => ({
    turnId: "turn",
    completedAtMs: at - 1000,
    item: { type: "commandExecution", id: "old-" + i },
  }));
  const entries = [
    ...prefix,
    row("checkpoint", "页面已完成，请确认导航方式。"),
    row("later", "我继续整理已经确认的样式。"),
  ];
  const base = transport(entries);
  const client = {
    ...base,
    request: async (method, args) => {
      if (method !== "thread/items/list") return base.request(method, args);
      const descending = args.sortDirection === "desc";
      let start = descending ? entries.length - 1 : 0;
      if (typeof args.cursor === "object")
        start = entries.findIndex((e) => e.item.id === args.cursor.itemId) + (descending ? -1 : 1);
      else if (args.cursor) start = Number(args.cursor);
      const selected = [];
      let i = start;
      for (; i >= 0 && i < entries.length && selected.length < args.limit; i += descending ? -1 : 1)
        selected.push(entries[i]);
      return { data: selected, nextCursor: i >= 0 && i < entries.length ? String(i) : null };
    },
  };
  const full = await readCheckpointItems(config, target, { since: at - 500, now: at + 500, client });
  assert.equal(full.complete, false);
  const exact = await readCheckpointItems(config, target, {
    since: at,
    now: at + 500,
    through: { turnId: "turn", itemId: "checkpoint" },
    client,
  });
  assert.equal(exact.complete, true);
  assert.deepEqual(
    exact.items.map((i) => i.itemId),
    ["checkpoint", "later"],
  );
  const missing = await readCheckpointItems(config, target, {
    since: at,
    now: at + 500,
    through: { turnId: "foreign", itemId: "checkpoint" },
    client,
  });
  assert.equal(missing.complete, false);
});
