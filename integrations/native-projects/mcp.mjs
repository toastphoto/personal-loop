import { createInterface } from "node:readline";
import { safeError } from "./catalog.mjs";

const string = { type: "string", minLength: 1 };
const tools = [
  {
    name: "native_loop_modes",
    description: "查看哪些项目仅查看、已启用自动推进或已暂停；新项目默认仅查看。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "native_projects_list",
    description: "查询Codex、Multica和DeepSeek原生项目目录；未连接来源明确标出，不推断为空。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "native_project_tasks",
    description: "读取指定原生项目的任务/会话元数据和状态，不读取完整聊天，不启动任务。",
    inputSchema: {
      type: "object",
      properties: { projectKey: string },
      required: ["projectKey"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "native_task_read",
    description: "查询一个已知任务的原生状态；执行结束不代表业务验收通过。",
    inputSchema: {
      type: "object",
      properties: { projectKey: string, nativeId: string },
      required: ["projectKey", "nativeId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

export async function serveMcp(catalog, { input = process.stdin, output = process.stdout, controls } = {}) {
  let initialized = false;
  const send = (id, value) => output.write(JSON.stringify({ jsonrpc: "2.0", id, ...value }) + "\n");
  const refuse = (id, code, message) => send(id, { error: { code, message } });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 64000) {
      refuse(null, -32600, "Request too large");
      continue;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      refuse(null, -32700, "Invalid JSON");
      continue;
    }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      refuse(request?.id ?? null, -32600, "Invalid request");
      continue;
    }
    if (request.id === undefined) continue;
    const { id, method, params } = request;
    if (method === "initialize") {
      initialized = true;
      send(id, {
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "personal-loop-native-projects", version: "0.1.0" },
        },
      });
      continue;
    }
    if (method === "ping") {
      send(id, { result: {} });
      continue;
    }
    if (!initialized) {
      refuse(id, -32600, "Initialize first");
      continue;
    }
    if (method === "tools/list") {
      send(id, { result: { tools } });
      continue;
    }
    if (method !== "tools/call") {
      refuse(id, -32601, "Unsupported method");
      continue;
    }
    const tool = tools.find((t) => t.name === params?.name);
    const args = params?.arguments ?? {};
    if (
      !tool ||
      !args ||
      Array.isArray(args) ||
      typeof args !== "object" ||
      Object.keys(args).some((k) => !(k in tool.inputSchema.properties)) ||
      (tool.inputSchema.required ?? []).some((k) => typeof args[k] !== "string" || !args[k].trim())
    ) {
      refuse(id, -32602, "Invalid tool arguments");
      continue;
    }
    try {
      const snapshot = await catalog.refresh();
      const result =
        tool.name === "native_loop_modes"
          ? {
              projects: snapshot.projects.map((p) => ({
                projectKey: p.key,
                name: p.name,
                provider: p.provider,
                ...(controls?.get(p.key) ?? { mode: "manual" }),
              })),
            }
          : tool.name === "native_projects_list"
            ? {
                ...snapshot,
                projects: snapshot.projects.map((p) => ({ ...p, loop: controls?.get(p.key) ?? { mode: "manual" } })),
              }
            : tool.name === "native_project_tasks"
              ? await catalog.listWork(args.projectKey)
              : await catalog.readWork(args.projectKey, args.nativeId);
      send(id, { result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      send(id, { result: { isError: true, content: [{ type: "text", text: safeError(error) }] } });
    }
  }
}
