#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createCatalog, readConfig } from "./factory.mjs";
import { safeError } from "./catalog.mjs";
import { serveMcp } from "./mcp.mjs";
import { publishObservation } from "./observe.mjs";
import { LoopControls } from "./controls.mjs";
import { NativeLoopRuntime } from "./loop-runtime.mjs";
import { handleLoopCommand } from "./feishu-commands.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--config");
const file = at >= 0 ? args.splice(at, 2)[1] : process.env.PERSONAL_LOOP_NATIVE_CONFIG;
const [command = "projects", projectKey, nativeId] = args;
if (!file) {
  console.error("Specify --config with the private native-projects configuration");
  process.exit(2);
}
const config = readConfig(file);
const catalog = createCatalog(config);
const controls = new LoopControls(config.controlsFile ?? path.join(path.dirname(file), "loop-modes.json"));
async function main() {
  if (command === "mode") {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const requestId = input.requestId ?? "local-" + randomUUID();
    const runtime = config.loopHub ? new NativeLoopRuntime({ nativeConfig: config, configFile: file, controls }) : null;
    let result;
    if (nativeId === "manual") {
      const before = controls.get(projectKey);
      const control = controls.set(projectKey, "manual", {
        actor: "local-owner",
        requestId,
        expectedRevision: input.expectedRevision ?? before.revision,
      });
      const sync = runtime ? await runtime.sync({ projectKey, control, action: "manual", requestId }) : { ok: true };
      result = { ok: sync.ok, control };
    } else {
      if (!["active", "paused"].includes(nativeId)) throw Object.assign(new Error(), { code: "INVALID_MODE_CHANGE" });
      result = await handleLoopCommand(
        {
          action: nativeId === "paused" ? "pause" : input.objective ? "enable" : "resume",
          target: projectKey,
          objective: input.objective,
          maxSteps: input.maxSteps,
        },
        {
          catalog,
          controls,
          actor: "local-owner",
          requestId,
          ...(runtime ? { readiness: (p) => runtime.readiness(p), syncRules: (a) => runtime.sync(a) } : {}),
        },
      );
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
    return;
  }
  if (command === "observe") {
    const configured = config.goals?.find((g) => g.id === projectKey);
    if (!configured?.projectKey) throw Object.assign(new Error(), { code: "GOAL_NOT_CONFIGURED" });
    const selected = controls.get(configured.projectKey);
    if (selected.mode !== "active") {
      console.log(JSON.stringify({ emitted: false, reason: "LOOP_NOT_ACTIVE", mode: selected.mode }));
      return;
    }
    controls.assertActive(configured.projectKey, selected.revision);
  }
  if (command === "mcp") await serveMcp(catalog, { controls });
  else {
    const overview = await catalog.refresh();
    let result;
    if (command === "projects")
      result = { ...overview, projects: overview.projects.map((p) => ({ ...p, loop: controls.get(p.key) })) };
    else if (command === "modes")
      result = {
        projects: overview.projects.map((p) => ({
          projectKey: p.key,
          name: p.name,
          provider: p.provider,
          ...controls.get(p.key),
        })),
      };
    else if (command === "tasks") result = await catalog.listWork(projectKey);
    else if (command === "read") result = await catalog.readWork(projectKey, nativeId);
    else if (command === "observe") {
      const goal = config.goals?.find((g) => g.id === projectKey);
      if (!goal?.projectKey || !goal.outputDirectory) throw Object.assign(new Error(), { code: "GOAL_NOT_CONFIGURED" });
      const control = controls.get(goal.projectKey);
      if (control.mode !== "active") {
        console.log(JSON.stringify({ emitted: false, reason: "LOOP_NOT_ACTIVE", mode: control.mode }));
        process.exitCode = 0;
      } else {
        const { project } = catalog.resolve(goal.projectKey);
        controls.assertActive(goal.projectKey, control.revision);
        const tasks = await catalog.listWork(project.key);
        const snapshot = { observedAt: new Date().toISOString(), project, tasks };
        mkdirSync(goal.outputDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(goal.outputDirectory, "native-state.json"), JSON.stringify(snapshot, null, 2) + "\n", {
          mode: 0o600,
        });
        if (!goal.hubConfigFile)
          result = {
            mode: "observe-only",
            projectKey: project.key,
            taskCount: tasks.items.length,
            complete: tasks.complete,
          };
        else {
          const hub = JSON.parse(readFileSync(goal.hubConfigFile, "utf8"));
          const url = new URL(hub.url);
          if (
            url.protocol !== "http:" ||
            !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
            !hub.source?.key
          )
            throw Object.assign(new Error(), { code: "INVALID_LOCAL_HUB_CONFIG" });
          const subject = createHash("sha256").update(project.key).digest("hex");
          controls.assertActive(goal.projectKey, control.revision);
          result = await publishObservation(
            subject,
            snapshot,
            path.join(goal.outputDirectory, "event-checkpoint.json"),
            async (payload) => {
              const response = await fetch(new URL("/v1/events", url), {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(10000),
                headers: { "content-type": "application/json", authorization: `Bearer ${hub.source.key}` },
                body: JSON.stringify(payload),
              });
              if (!response.ok) throw Object.assign(new Error(), { code: "HUB_EVENT_REJECTED" });
              return response.json();
            },
          );
        }
      }
    } else throw Object.assign(new Error(), { code: "UNKNOWN_COMMAND" });
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  }
}
try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ error: safeError(error) }));
  process.exitCode = 1;
} finally {
  await catalog.close();
}
