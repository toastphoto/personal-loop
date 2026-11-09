import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { startLoopHub } from "./hub-host.mjs";
function config(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "owned-hub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:12345", owner: "local-test-only" }));
  return { loopHub: { autoStart: true, configFile: file, rulesFile: path.join(dir, "rules.json") } };
}
test("an existing verified hub is reused and never terminated", async (t) => {
  let calls = 0;
  const hub = await startLoopHub(config(t), {
    owner: { state: async () => ({ runs: [], sources: [] }) },
    spawn: () => {
      calls++;
    },
  });
  await hub.stop();
  assert.equal(hub.owned, false);
  assert.equal(calls, 0);
});
test("an occupied endpoint with failed authentication is not replaced", async (t) => {
  let calls = 0;
  await assert.rejects(
    startLoopHub(config(t), {
      owner: {
        state: async () => {
          throw { status: 401 };
        },
      },
      spawn: () => {
        calls++;
      },
    }),
    /LOOP_HUB_EXISTING_UNVERIFIED/,
  );
  assert.equal(calls, 0);
});
test("a dedicated child starts with trusted home and rules and can be stopped", async (t) => {
  let checks = 0,
    kills = [];
  const c = config(t),
    child = new EventEmitter();
  child.kill = (s) => kills.push(s);
  let args;
  const hub = await startLoopHub(c, {
    owner: {
      state: async () => {
        if (checks++ === 0) throw new Error("connection refused");
        return { runs: [], sources: [] };
      },
    },
    spawn: (program, argv, options) => {
      args = { program, argv, options };
      return child;
    },
    wait: async () => {},
  });
  assert.equal(hub.owned, true);
  assert.equal(args.options.env.AGENT_AUTOLOOP_HOME, path.dirname(c.loopHub.configFile));
  assert.equal(args.argv.at(-1), "up");
  await hub.stop();
  assert.deepEqual(kills, ["SIGTERM"]);
});
