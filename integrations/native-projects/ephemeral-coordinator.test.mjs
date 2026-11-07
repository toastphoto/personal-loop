// The hidden planning turn never persists a project thread, changes the project, or reads another conversation.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundProgress, runEphemeralCoordinator } from "./ephemeral-coordinator.mjs";

function executable(t, code) {
  const dir = mkdtempSync(path.join(tmpdir(), "router-exec-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-codex");
  writeFileSync(file, "#!" + process.execPath + "\n" + code, { mode: 0o700 });
  return file;
}
const events = (msg, usage) =>
  [
    { type: "thread.started", thread_id: "temporary" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: msg } },
    { type: "turn.completed", usage },
  ]
    .map((v) => JSON.stringify(v))
    .join("\n");

test("one ephemeral single-turn process has a private cwd, stdin prompt, no tool or project access and explicit usage", async (t) => {
  const command = executable(
    t,
    `const fs=require("node:fs");const prompt=fs.readFileSync(0,"utf8");const args=process.argv.slice(2);
for (const k of ["--json","--ephemeral","--ignore-user-config","--sandbox","read-only","multi_agent","apps","shell_tool","unified_exec","approval_policy=\\"never\\""]) if(!args.includes(k))process.exit(2);
if(args.at(-1)!=="-"||args.includes("resume")||args.includes("fork")||args.some(v=>v.includes("EXACT-GOAL"))||prompt!=="EXACT-GOAL")process.exit(3);
const msg=JSON.stringify({cwd:process.cwd(),action:"dispatch"}); console.log(JSON.stringify({type:"thread.started",thread_id:"temporary"}));
console.log(JSON.stringify({type:"turn.started"}));console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:msg}})); console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:20,output_tokens:5,cached_input_tokens:10}}));`,
  );
  let guarded = 0;
  const result = await runEphemeralCoordinator({ command, prompt: "EXACT-GOAL", beforeStart: () => guarded++ });
  assert.equal(guarded, 1);
  assert.equal(result.session, undefined);
  assert.equal(JSON.parse(result.text).action, "dispatch");
  assert.equal(existsSync(JSON.parse(result.text).cwd), false);
  assert.deepEqual(result.turnUsage, { input: 20, output: 5, cached: 10 });
  assert.equal(result.turnUsageStatus, "complete");
});

test("unfinished turns and failed exit never produce a handoff; unreported usage stays missing", async (t) => {
  for (const [output, code] of [
    [events("partial", {}).split("\n").slice(0, -1).join("\n"), 0],
    [events("bad", {}), 5],
  ]) {
    const command = executable(t, `console.log(${JSON.stringify(output)});process.exitCode=${code};`);
    await assert.rejects(runEphemeralCoordinator({ command, prompt: "goal" }));
  }
  const command = executable(t, `console.log(${JSON.stringify(events('{"action":"dispatch"}', {}))});`);
  const r = await runEphemeralCoordinator({ command, prompt: "goal" });
  assert.equal(r.turnUsageStatus, "missing");
  assert.equal(r.turnUsage, undefined);
});

test("cancellation stops the coordinator, including a process which ignores polite shutdown", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "router-abort-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const receipt = path.join(dir, "pid");
  const command = executable(
    t,
    `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(${JSON.stringify(receipt)},String(process.pid));setInterval(()=>{},1000)`,
  );
  const ctrl = new AbortController();
  const promise = runEphemeralCoordinator({ command, prompt: "goal", signal: ctrl.signal, timeoutMs: 20000 });
  t.after(async () => {
    ctrl.abort();
    await promise.catch(() => {});
  });
  const deadline = Date.now() + 10000;
  while (!existsSync(receipt) && Date.now() < deadline) await delay(25);
  assert.ok(existsSync(receipt));
  ctrl.abort();
  await assert.rejects(promise, { code: "EPHEMERAL_COORDINATOR_ABORTED" });
  await assert.rejects(runEphemeralCoordinator({ command, prompt: "goal", signal: ctrl.signal }), {
    code: "EPHEMERAL_COORDINATOR_ABORTED",
  });
});
const threadId = "manual",
  projectId = "company",
  projectKey = "codex:local:company",
  cwd = "/work/company";
test("only selected chat's visible reply is passed; a legacy root is checked again after reading", async () => {
  let current = cwd;
  const bodies = [];
  const backend = {
    async rawWork(id) {
      return { id, cwd: current, projectId: null, ephemeral: false };
    },
    async listProjects() {
      return { projects: [{ nativeId: projectId, roots: [cwd] }], complete: true };
    },
    async listWork() {
      return {
        items: [
          { nativeId: threadId, projectId, membership: "cwd-unassigned" },
          { nativeId: "newest", projectId },
        ],
        complete: true,
      };
    },
    async readConversation(id, opts) {
      bodies.push(id);
      return {
        nativeId: id,
        projectId: opts.projectId,
        latestReply: { text: "实测已接回，尚待验收。", phase: "final_answer" },
        complete: true,
      };
    },
  };
  const args = { catalog: { connectors: { codex: backend } }, projectKey, projectId, cwd, threadId };
  const res = await readBoundProgress(args);
  assert.match(res.excerpt, /实测已接回/);
  assert.deepEqual(bodies, [threadId]);
  const previous = backend.readConversation;
  backend.readConversation = async (...a) => {
    let r = await previous(...a);
    current = "/other";
    return r;
  };
  await assert.rejects(readBoundProgress(args), { code: "BOUND_PROGRESS_SCOPE_MISMATCH" });
});

test(
  "the installed CLI uses an isolated home and a synthetic loopback model without creating a rollout",
  {
    skip: !process.env.PERSONAL_LOOP_TEST_CODEX,
  },
  async (t) => {
    const { createServer } = await import("node:http");
    const { once } = await import("node:events");
    const { zstdDecompressSync, gunzipSync } = await import("node:zlib");
    const root = mkdtempSync(path.join(tmpdir(), "coordinator-fake-provider-"));
    t.after(() => rmSync(root, { force: true, recursive: true }));
    const seen = [];
    const message = {
      type: "message",
      id: "msg_fixture",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: '{"action":"dispatch"}' }],
    };
    const reply = {
      id: "resp_local",
      status: "completed",
      model: "synthetic",
      object: "response",
      output: [message],
      usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 5 }, output_tokens: 8, total_tokens: 28 },
    };
    const server = createServer(async (req, res) => {
      let body = Buffer.concat(await Array.fromAsync(req));
      if (req.headers["content-encoding"] === "zstd") body = zstdDecompressSync(body);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      seen.push({ url: req.url, tools: JSON.parse(body).tools?.map((x) => x.name ?? x.type) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = [
        { type: "response.created", response: { ...reply, status: "in_progress", output: [] } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          delta: message.content[0].text,
        },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response: reply },
      ];
      for (const e of frames) res.write("event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n");
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = "http://127.0.0.1:" + server.address().port + "/v1";
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      CODEX_HOME: path.join(root, "codex"),
      OPENAI_BASE_URL: url,
      OPENAI_API_KEY: "synthetic-local-only",
      NO_PROXY: "127.0.0.1,localhost",
    };
    mkdirSync(env.CODEX_HOME, { mode: 0o700 });
    const testArgs = [
      "-c",
      'model_provider="audit"',
      "-m",
      "synthetic",
      "-c",
      'model_providers.audit.name="audit"',
      "-c",
      "model_providers.audit.base_url=" + JSON.stringify(url),
      "-c",
      'model_providers.audit.wire_api="responses"',
      "-c",
      "model_providers.audit.request_max_retries=0",
      "-c",
      "model_providers.audit.stream_max_retries=0",
    ];
    const command = executable(
      t,
      `const cp=require('node:child_process'); const args=process.argv.slice(2,-1).concat(${JSON.stringify(testArgs)},'-');
    const p=cp.spawn(${JSON.stringify(process.env.PERSONAL_LOOP_TEST_CODEX)},args,{env:${JSON.stringify(env)},stdio:"inherit"});p.on('close',code=>process.exit(code??1));`,
    );
    const result = await runEphemeralCoordinator({ command, prompt: "synthetic planning input", timeoutMs: 12000 });
    assert.equal(JSON.parse(result.text).action, "dispatch");
    assert.deepEqual(result.turnUsage, { input: 20, output: 8, cached: 5 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/v1/responses");
    // The standalone runner cannot service the CLI's non-executing request_user_input declaration in default mode.
    assert.ok(
      seen[0].tools.every((name) => name === "request_user_input"),
      JSON.stringify(seen[0].tools),
    );
    assert.equal(existsSync(path.join(env.CODEX_HOME, "sessions")), false);
    const { DatabaseSync } = await import("node:sqlite");
    for (const file of readdirSync(env.CODEX_HOME).filter((name) => /^state_\d+\.sqlite$/.test(name))) {
      const db = new DatabaseSync(path.join(env.CODEX_HOME, file), { readOnly: true });
      try {
        assert.equal(db.prepare("select count(*) as n from threads").get().n, 0);
      } finally {
        db.close();
      }
    }
  },
);
