// Do not wake an unrelated, completed or revoked task, and never duplicate an acknowledged queue entry.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { wakeQueuedBoundChat } from "./bound-wake.mjs";
test("a scoped queued original opens in the background once without queuing another message", async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "wake-original-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  new DatabaseSync(path.join(dir, "bound-chat.db")).close();
  chmodSync(path.join(dir, "bound-chat.db"), 0o600);
  const key = "codex:local:p",
    threadId = "11111111-1111-4111-8111-111111111111";
  const config = {
    managedCodex: {
      command: "/Applications/ChatGPT.app/Contents/MacOS/codex",
      stateDir: dir,
      wakeBoundProjectKeys: [key],
      boundChats: { [key]: { threadId } },
    },
  };
  let calls = [];
  let status = "queued";
  let allowed = true;
  const args = { config, projectKey: key, requestId: "r1", text: "actual goal", beforeMutation: () => allowed };
  const deps = {
    platform: "darwin",
    exists: () => true,
    inspect: async () => ({ status, threadId }),
    launch: async (a) => {
      calls.push(a);
      return true;
    },
  };
  assert.equal((await wakeQueuedBoundChat(args, deps)).status, "wake-requested");
  await wakeQueuedBoundChat(args, deps);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["-g", "-a", "/Applications/ChatGPT.app", `codex://threads/${threadId}`]);
  status = "completed";
  await wakeQueuedBoundChat({ ...args, requestId: "r2" }, deps);
  assert.equal(calls.length, 1);
  status = "queued";
  allowed = false;
  await assert.rejects(wakeQueuedBoundChat({ ...args, requestId: "r3" }, deps));
  assert.equal(calls.length, 1);
  config.managedCodex.wakeBoundProjectKeys = [];
  assert.equal((await wakeQueuedBoundChat({ ...args, requestId: "r4" }, deps)).status, "disabled");
});
