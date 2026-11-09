import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hubClient } from "../../protocol/client.ts";
import { failure } from "./catalog.mjs";

// Own only the dedicated hub child. No system service or existing app is restarted here.
export async function startLoopHub(config, dependencies = {}) {
  if (!config?.loopHub?.autoStart) return { ready: false, owned: false, stop: async () => {} };
  const settings = config.loopHub;
  if (!path.isAbsolute(settings.configFile ?? "") || !path.isAbsolute(settings.rulesFile ?? ""))
    throw failure("LOOP_HUB_CONFIG_INVALID");
  const privateConfig = JSON.parse(readFileSync(settings.configFile, "utf8"));
  const url = new URL(privateConfig.url);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !privateConfig.owner
  )
    throw failure("LOOP_HUB_CONFIG_INVALID");
  const owner = dependencies.owner ?? hubClient(url.href, privateConfig.owner);
  const valid = (state) => Array.isArray(state?.runs) && Array.isArray(state?.sources);
  try {
    if (!valid(await owner.state())) throw failure("LOOP_HUB_RESPONSE_INVALID");
    return { ready: true, owned: false, stop: async () => {} };
  } catch (error) {
    if (error.status || error.code === "LOOP_HUB_RESPONSE_INVALID") throw failure("LOOP_HUB_EXISTING_UNVERIFIED");
  }
  const home = path.dirname(settings.configFile);
  const logs = path.join(home, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const output = openSync(path.join(logs, "up.log"), "a", 0o600);
  const launch = dependencies.spawn ?? spawn;
  let child;
  try {
    child = launch(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        fileURLToPath(new URL("../../bin/agent-autoloop.ts", import.meta.url)),
        "up",
      ],
      {
        shell: false,
        stdio: ["ignore", output, output],
        env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_RULES: settings.rulesFile },
      },
    );
  } finally {
    closeSync(output);
  }
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", () => {
    exited = true;
  });
  const stop = async () => {
    if (!exited) child.kill("SIGTERM");
  };
  const wait = dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < 50; i++) {
    if (exited) throw failure("LOOP_HUB_START_FAILED");
    try {
      if (valid(await owner.state())) return { ready: true, owned: true, stop };
    } catch {}
    await wait(100);
  }
  await stop();
  throw failure("LOOP_HUB_START_TIMEOUT");
}
