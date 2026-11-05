import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveMcp } from "./mcp.mjs";
test("read-only MCP rejects undeclared actions and never leaks internal errors", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let received = "";
  output.on("data", (chunk) => {
    received += chunk;
  });
  let reads = 0;
  const running = serveMcp(
    {
      refresh: async () => {
        reads++;
        throw Object.assign(new Error("private secret output"), { code: "HOST_UNAVAILABLE" });
      },
    },
    { input, output },
  );
  for (const message of [
    { id: 1, method: "tools/list" },
    { id: 2, method: "initialize", params: {} },
    { id: 3, method: "tools/list" },
    { id: 4, method: "tools/call", params: { name: "native_task_continue", arguments: {} } },
    { id: 5, method: "tools/call", params: { name: "native_projects_list", arguments: { command: "arbitrary" } } },
    { id: 6, method: "tools/call", params: { name: "native_projects_list", arguments: {} } },
  ])
    input.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  input.end();
  await running;
  const responses = received.trim().split("\n").map(JSON.parse);
  assert.equal(responses[0].error.code, -32600);
  assert.ok(responses[2].result.tools.every((t) => t.annotations.readOnlyHint));
  assert.equal(responses[3].error.code, -32602);
  assert.equal(responses[4].error.code, -32602);
  assert.equal(reads, 1);
  assert.ok(!received.includes("private secret output"));
  assert.ok(received.includes("HOST_UNAVAILABLE"));
});
