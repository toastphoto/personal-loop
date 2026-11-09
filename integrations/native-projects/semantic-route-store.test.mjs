// An edited, revoked, duplicated or unresolved owner message must never escape to legacy issue creation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readSemanticRoute, finishSemanticRoute } from "./semantic-route-store.mjs";
import { routeProjectMessage } from "./feishu-route.mjs";
function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "semantic-route-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "receipts");
  mkdirSync(dir, { mode: 0o700 });
  const start = Date.now() - 1000;
  const cfg = {
    enabled: true,
    chatId: "oc_group",
    allowedSenderIds: ["ou_person"],
    botMentionIds: ["ou_bot"],
    projectNames: ["工作台"],
    semanticQueries: { enabled: true, enabledAt: new Date(start).toISOString(), decisionDir: dir },
  };
  const ev = {
    chat_id: "oc_group",
    sender_id: "ou_person",
    message_id: "om_a",
    message_type: "text",
    sender_type: "user",
    mentions: [{ id: "ou_bot", name: "大肥鱼" }],
    content: "@大肥鱼 私密信息占位，要做张海报",
    create_time: String(start + 10),
  };
  const file = path.join(home, "routing.json");
  writeFileSync(file, JSON.stringify(cfg));
  const invoke = (ev, settle = false) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./feishu-route.mjs", import.meta.url)), file, ...(settle ? ["--settle-pending"] : [])],
      { input: JSON.stringify(ev), encoding: "utf8" },
    );
  return { cfg, ev, dir, file, home, invoke, start };
}
test("unknown owner wording waits on one durable semantic verdict; CLI reads only matching receipts", (t) => {
  const { cfg, ev, dir, invoke } = fixture(t);
  assert.equal(routeProjectMessage(ev, cfg), "semantic");
  for (const settle of [false, true]) assert.equal(invoke(ev, settle).stdout, "pending");
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(readSemanticRoute(ev, cfg), "pending");
  assert.equal(finishSemanticRoute(ev, cfg, "legacy"), "legacy");
  assert.equal(finishSemanticRoute(ev, cfg, "legacy"), "legacy");
  assert.equal(readSemanticRoute(ev, cfg), "legacy");
  for (const settle of [false, true]) assert.equal(invoke(ev, settle).stdout, "legacy");
  assert.throws(() => finishSemanticRoute(ev, cfg, "loop"), { code: "SEMANTIC_VERDICT_CONFLICT" });
  assert.equal(readdirSync(dir).length, 1);
  const payload = readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8");
  for (const raw of [ev.message_id, ev.sender_id, ev.chat_id, ev.content]) assert.ok(!payload.includes(raw));
  for (const edited of [
    { content: "做另一个动作" },
    { create_time: String(+ev.create_time + 1) },
    { mentions: [{ id: "ou_bot", name: "edited" }] },
  ]) {
    assert.notEqual(invoke({ ...ev, ...edited }, true).stdout, "legacy");
    assert.throws(() => finishSemanticRoute({ ...ev, ...edited }, cfg, "legacy"), {
      code: "SEMANTIC_VERDICT_CONFLICT",
    });
  }
});
test("rollout epoch, genuine single mention and scope apply at settlement; disabling after deferral is never permission to create", (t) => {
  const { cfg, ev, file, invoke, start } = fixture(t);
  for (const overrides of [
    { message_id: "bad" },
    { sender_id: "ou_other" },
    { chat_id: "oc_other" },
    { mentions: [] },
    { mentions: [...ev.mentions, ...ev.mentions] },
    { create_time: String(start - 1) },
    { create_time: "" },
    { message_type: "post" },
  ]) {
    const wrong = { ...ev, ...overrides };
    assert.equal(routeProjectMessage(wrong, cfg), "legacy");
    assert.notEqual(invoke(wrong, true).stdout, "legacy");
    assert.throws(() => finishSemanticRoute(wrong, cfg, "legacy"), { code: "SEMANTIC_SCOPE_DENIED" });
  }
  assert.equal(routeProjectMessage({ ...ev, content: "列出我的项目" }, cfg), "loop");
  assert.equal(invoke({ ...ev, content: "/loop 项目" }).stdout, "loop");
  finishSemanticRoute(ev, cfg, "loop");
  assert.equal(invoke(ev, true).stdout, "loop");
  cfg.semanticQueries.enabled = false;
  writeFileSync(file, JSON.stringify(cfg));
  assert.equal(invoke(ev, false).stdout, "legacy");
  assert.equal(invoke(ev, true).stdout, "loop");
});
test("unsafe, corrupt or unavailable private records never authorize external dispatch", (t) => {
  const { cfg, ev, dir, invoke, home } = fixture(t);
  chmodSync(dir, 0o755);
  assert.equal(invoke(ev, true).stdout, "pending");
  assert.throws(() => finishSemanticRoute(ev, cfg, "legacy"));
  chmodSync(dir, 0o700);
  finishSemanticRoute(ev, cfg, "legacy");
  const f = path.join(dir, readdirSync(dir)[0]);
  const raw = readFileSync(f);
  writeFileSync(f, "{");
  assert.notEqual(invoke(ev, true).stdout, "legacy");
  assert.throws(() => finishSemanticRoute(ev, cfg, "legacy"));
  rmSync(f);
  writeFileSync(path.join(home, "out"), raw, { mode: 0o600 });
  symlinkSync(path.join(home, "out"), f);
  assert.notEqual(invoke(ev, true).stdout, "legacy");
  assert.throws(() => finishSemanticRoute(ev, cfg, "legacy"));
});

test("racing processes cannot both claim the same message with different verdicts", async (t) => {
  const { cfg, ev, dir, invoke } = fixture(t);
  const url = new URL("./semantic-route-store.mjs", import.meta.url).href;
  const script = `import fs from 'node:fs';import {finishSemanticRoute} from ${JSON.stringify(url)}; const {e,r,owner}=JSON.parse(fs.readFileSync(0,'utf8'));try{process.stdout.write(finishSemanticRoute(e,r,owner))}catch(e){process.stdout.write(e.code)}`;
  const { spawn } = await import("node:child_process");
  const run = (owner) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      p.once("error", reject);
      p.stdout.on("data", (c) => (out += c));
      p.once("close", () => resolve(out));
      p.stdin.end(JSON.stringify({ e: ev, r: cfg, owner }));
    });
  const receipts = await Promise.all([run("loop"), run("legacy")]);
  const accepted = receipts.filter((v) => v === "loop" || v === "legacy");
  assert.equal(accepted.length, 1);
  assert.ok(receipts.includes("SEMANTIC_VERDICT_CONFLICT"));
  assert.equal(readdirSync(dir).length, 1);
  assert.equal(invoke(ev, true).stdout, accepted[0]);
});
