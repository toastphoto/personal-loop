import { readFileSync } from "node:fs";
import path from "node:path";
import { ProjectCatalog, failure, projectKey } from "./catalog.mjs";
import { CodexConnector } from "./codex.mjs";
import { MulticaConnector } from "./multica.mjs";
import { LoopControls } from "./controls.mjs";
import { effectiveBoundChats } from "./chat-binding-store.mjs";
import { DshConnector } from "./dsh.mjs";
import { DshBridgeConnector } from "./dsh-bridge.mjs";

export function readConfig(file) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.version !== 1 || !value.providers || typeof value.providers !== "object") throw failure("INVALID_CONFIG");
  for (const name of Object.keys(value.providers))
    if (!["codex", "multica", "dsh"].includes(name)) throw failure("UNKNOWN_PROVIDER");
  if (value.managedCodex && path.isAbsolute(value.controlsFile ?? "")) {
    const managed = value.managedCodex,
      base = managed.boundChats ?? {},
      controls = new LoopControls(value.controlsFile);
    Object.defineProperty(managed, "boundChats", {
      enumerable: true,
      get: () => effectiveBoundChats(base, controls.read()),
    });
  }
  return value;
}
export function createCatalog(config) {
  const constructors = { codex: CodexConnector, multica: MulticaConnector, dsh: DshConnector };
  const connectors = {};
  for (const [name, options] of Object.entries(config.providers)) {
    if (options.enabled === false) continue;
    // Read connections never inherit write permission from arbitrary provider options.
    const Constructor = name === "dsh" && options.bridgeSocket ? DshBridgeConnector : constructors[name];
    const connector = new Constructor({ ...options, writeEnabled: false });
    if (name === "codex" && config.managedCodex?.enabled === true) {
      const original = connector.listProjects.bind(connector);
      connector.listProjects = async () => {
        const result = await original();
        return {
          ...result,
          projects: result.projects.map((p) => {
            const key = projectKey(name, p.host ?? "local", p.nativeId),
              root = config.managedCodex.projectRoots?.[key];
            const bound = Object.hasOwn(config.managedCodex.boundChats ?? {}, key);
            const available = typeof root === "string" && path.isAbsolute(root) && p.roots.includes(root);
            return {
              ...p,
              capabilities: {
                ...p.capabilities,
                startOwned: available && !bound,
                ...(bound && { queueBound: available }),
                continuationMode: available ? (bound ? "bound-chat" : "managed-read-only") : undefined,
              },
            };
          }),
        };
      };
    }
    connectors[name] = connector;
  }
  return new ProjectCatalog(connectors);
}
