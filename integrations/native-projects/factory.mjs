import { readFileSync } from "node:fs";
import { ProjectCatalog, failure } from "./catalog.mjs";
import { CodexConnector } from "./codex.mjs";
import { MulticaConnector } from "./multica.mjs";
import { DshConnector } from "./dsh.mjs";

export function readConfig(file) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.version !== 1 || !value.providers || typeof value.providers !== "object") throw failure("INVALID_CONFIG");
  for (const name of Object.keys(value.providers))
    if (!["codex", "multica", "dsh"].includes(name)) throw failure("UNKNOWN_PROVIDER");
  return value;
}
export function createCatalog(config) {
  const constructors = { codex: CodexConnector, multica: MulticaConnector, dsh: DshConnector };
  const connectors = {};
  for (const [name, options] of Object.entries(config.providers)) {
    if (options.enabled === false) continue;
    // Read connections never inherit write permission from arbitrary provider options.
    connectors[name] = new constructors[name]({ ...options, writeEnabled: false });
  }
  return new ProjectCatalog(connectors);
}
