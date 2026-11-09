// Failures covered: wrong-owner/public/symlinked sockets, unbounded or broken frames,
// guessed workspace membership, lost partial-directory status and accidental mutation support.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, chmod, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { startBridge } from "../dsh-native-bridge/index.mjs";
import { DshBridgeConnector } from "./dsh-bridge.mjs";

async function temp(t) {
  const folder = await mkdtemp(path.join(tmpdir(), "dshc-"));
  await chmod(folder, 0o700);
  t.after(async () => rm(folder, { recursive: true, force: true }));
  return { folder, socket: path.join(folder, "bridge.sock") };
}
function host() {
  const workspaces = [
    {
      id: "workspace-one",
      title: "原生项目",
      path: "/private/project",
      sessionIds: ["session-one", "session-two"],
      createdAt: 10,
      updatedAt: 20,
    },
  ];
  const sessions = [
    { header: { id: "session-one", cwd: "/private/project", createdAt: 10 }, live: true, persisted: true },
    { header: { id: "session-two", cwd: "/private/project", createdAt: 11 }, live: false, persisted: true },
    { header: { id: "unassigned", cwd: "/private/project", createdAt: 12 }, live: false, persisted: true },
  ];
  const agents = new Map([["session-one", { status: "running" }]]);
  return {
    workspaceRegistry: { list: () => workspaces },
    sessionQuery: { listSessions: async () => sessions },
    agents,
    workspaces,
    sessions,
  };
}
async function plugin(t, values = host(), options = {}) {
  const at = await temp(t);
  const bridge = await startBridge(values, { socketPath: at.socket, ...options });
  t.after(() => bridge.close());
  return { ...at, bridge, values, connector: new DshBridgeConnector({ bridgeSocket: at.socket, timeoutMs: 500 }) };
}
const envelope = (result) => ({
  ...result,
  observedAt: "2026-01-01T00:00:00Z",
  complete: true,
  bridgeInstance: "same-host",
  hostProcessId: process.pid,
});
const workspace = () => ({ workspaceId: "w", title: "中文项目", path: "/private/project", sessionIds: ["s"] });
const session = (overrides = {}) => ({
  sessionId: "s",
  projectId: "w",
  cwd: "/private/project",
  title: null,
  createdAt: 10,
  updatedAt: null,
  running: null,
  state: "unknown",
  nativeState: "not_loaded",
  agentAvailable: false,
  origin: "root",
  live: false,
  persisted: true,
  ...overrides,
});
async function fakeServer(t, handler) {
  const at = await temp(t);
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) handler(JSON.parse(data.slice(0, data.indexOf("\n"))), socket);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(at.socket, resolve);
  });
  await chmod(at.socket, 0o600);
  t.after(async () => {
    for (const client of clients) client.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { ...at, connector: new DshBridgeConnector({ bridgeSocket: at.socket, timeoutMs: 100 }) };
}
const code = (expected) => (error) => error.code === expected;

test("real plugin UDS exposes native projects and membership metadata only", async (t) => {
  const { connector } = await plugin(t);
  const projects = await connector.listProjects();
  assert.equal(projects.complete, true);
  assert.equal(projects.projects[0].nativeId, "workspace-one");
  assert.equal(projects.projects[0].name, "原生项目");
  assert.deepEqual(projects.projects[0].capabilities, { read: true, continue: false, cancel: false });
  const work = await connector.listWork("workspace-one");
  assert.equal(work.items.length, 2);
  assert.equal(work.items[0].projectId, "workspace-one");
  assert.equal(work.items[0].state, "running");
  assert.equal(work.items[1].state, "unknown");
  assert.equal(work.items[1].nativeState, "not_loaded");
  assert.equal((await connector.readStatus("session-one")).state, "running");
  assert.equal((await connector.readWork("session-two")).membership, "native-project");
  await assert.rejects(connector.readWork("unassigned"), code("DSH_BRIDGE_WORK_NOT_REGISTERED"));
});
test("missing native members remain a partial directory, never silently complete", async (t) => {
  const values = host();
  values.sessions.splice(1, 1);
  const { connector } = await plugin(t, values);
  const work = await connector.listWork("workspace-one");
  assert.equal(work.complete, false);
  assert.equal(work.items.length, 1);
});
test("mutations and arbitrary RPC forwarding are unavailable without connecting", async () => {
  const connector = new DshBridgeConnector({ bridgeSocket: "/does/not/exist.sock" });
  await assert.rejects(connector.continueWork({ nativeId: "s" }), code("DSH_WRITE_DISABLED"));
  await assert.rejects(connector.cancelWork({ nativeId: "s" }), code("DSH_WRITE_DISABLED"));
  assert.equal(connector.call, undefined);
  assert.equal(connector.request, undefined);
});
test("parent and socket must have exact private permissions before any request", async (t) => {
  let requests = 0;
  const { connector, folder, socket } = await fakeServer(t, () => requests++);
  await chmod(folder, 0o755);
  await assert.rejects(connector.listProjects(), code("DSH_BRIDGE_PRIVATE_DIRECTORY_REQUIRED"));
  await chmod(folder, 0o700);
  await chmod(socket, 0o660);
  await assert.rejects(connector.listProjects(), code("DSH_BRIDGE_PRIVATE_SOCKET_REQUIRED"));
  assert.equal(requests, 0);
});
test("symlink parents, symlink sockets and regular files are rejected", async (t) => {
  const actual = await fakeServer(t, () => {});
  const links = await temp(t);
  const link = path.join(links.folder, "socket-link");
  await symlink(actual.socket, link);
  await assert.rejects(
    new DshBridgeConnector({ bridgeSocket: link }).listProjects(),
    code("DSH_BRIDGE_PRIVATE_SOCKET_REQUIRED"),
  );
  const parent = path.join(links.folder, "parent-link");
  await symlink(actual.folder, parent);
  await assert.rejects(
    new DshBridgeConnector({ bridgeSocket: path.join(parent, "bridge.sock") }).listProjects(),
    code("DSH_BRIDGE_PRIVATE_DIRECTORY_REQUIRED"),
  );
  const file = path.join(links.folder, "regular");
  await writeFile(file, "not a socket", { mode: 0o600 });
  await assert.rejects(
    new DshBridgeConnector({ bridgeSocket: file }).listProjects(),
    code("DSH_BRIDGE_PRIVATE_SOCKET_REQUIRED"),
  );
});
test("the socket owner must equal the current process user", async (t) => {
  const { connector } = await fakeServer(t, () => {});
  const original = process.getuid;
  const uid = original();
  process.getuid = () => uid + 1;
  try {
    await assert.rejects(connector.listProjects(), code("DSH_BRIDGE_PRIVATE_DIRECTORY_REQUIRED"));
  } finally {
    process.getuid = original;
  }
});
test("permission checks run again for every new connection", async (t) => {
  const { connector, socket } = await fakeServer(t, (request, channel) =>
    channel.end(JSON.stringify({ id: request.id, ok: true, result: envelope({ items: [workspace()] }) }) + "\n"),
  );
  assert.equal((await connector.listProjects()).projects.length, 1);
  await chmod(socket, 0o644);
  await assert.rejects(connector.listProjects(), code("DSH_BRIDGE_PRIVATE_SOCKET_REQUIRED"));
});
test("fragmented UTF-8 response is reconstructed without corruption", async (t) => {
  const { connector } = await fakeServer(t, (request, channel) => {
    const value = Buffer.from(
      JSON.stringify({ id: request.id, ok: true, result: envelope({ items: [workspace()] }) }) + "\n",
    );
    const split = value.indexOf(Buffer.from("中文")) + 1;
    channel.write(value.subarray(0, split));
    setTimeout(() => channel.end(value.subarray(split)), 5);
  });
  assert.equal((await connector.listProjects()).projects[0].name, "中文项目");
});
test("timeouts, early EOF, bad JSON, wrong IDs and oversized replies fail explicitly", async (t) => {
  const cases = [
    [() => {}, "DSH_BRIDGE_TIMEOUT"],
    [(_r, c) => c.end(), "DSH_BRIDGE_DISCONNECTED"],
    [(_r, c) => c.end("invalid\n"), "DSH_BRIDGE_INVALID_RESPONSE"],
    [
      (_r, c) => c.end(JSON.stringify({ id: "different", ok: true, result: {} }) + "\n"),
      "DSH_BRIDGE_RESPONSE_ID_MISMATCH",
    ],
    [(_r, c) => c.end("x".repeat(1025)), "DSH_BRIDGE_RESPONSE_TOO_LARGE"],
  ];
  for (const [handler, expected] of cases) {
    const at = await fakeServer(t, handler);
    const connector = new DshBridgeConnector({ bridgeSocket: at.socket, timeoutMs: 30, maxResponseBytes: 1024 });
    await assert.rejects(connector.listProjects(), code(expected));
  }
});
test("remote errors preserve safe codes and never echo private exception text", async (t) => {
  const { connector } = await fakeServer(t, (request, channel) =>
    channel.end(
      JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: "READ_TIMEOUT", message: "private body credential" },
      }) + "\n",
    ),
  );
  await assert.rejects(
    connector.listProjects(),
    (error) => error.code === "DSH_BRIDGE_READ_TIMEOUT" && !error.message.includes("private"),
  );
});
test("workspace/session ownership is checked rather than inferred from cwd", async (t) => {
  const { connector } = await fakeServer(t, (request, channel) => {
    const result =
      request.method === "workspace/list"
        ? envelope({ items: [workspace()] })
        : envelope({ items: [session({ projectId: "another" })] });
    channel.end(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
  });
  await assert.rejects(connector.listWork("w"), code("DSH_BRIDGE_PROJECT_MISMATCH"));
});
test("host replacement between membership and session reads is rejected", async (t) => {
  const { connector } = await fakeServer(t, (request, channel) => {
    const result =
      request.method === "workspace/list"
        ? envelope({ items: [workspace()] })
        : { ...envelope(session()), bridgeInstance: randomUUID() };
    channel.end(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
  });
  await assert.rejects(connector.readWork("s"), code("DSH_BRIDGE_HOST_CHANGED"));
});
test("sensitive or unknown fields in native metadata do not appear in public results", async (t) => {
  const { connector } = await fakeServer(t, (request, channel) =>
    channel.end(
      JSON.stringify({
        id: request.id,
        ok: true,
        result: envelope({
          items: [{ ...workspace(), transcript: "private conversation", secret: "private credential" }],
        }),
      }) + "\n",
    ),
  );
  const result = await connector.listProjects();
  assert.ok(!JSON.stringify(result).includes("private conversation"));
  assert.ok(!JSON.stringify(result).includes("private credential"));
});

test("conversation preview is opt-in and scope/limits are validated before connecting", async () => {
  const denied = new DshBridgeConnector({ bridgeSocket: "/not/available.sock" });
  await assert.rejects(denied.readConversation("s", { projectId: "w" }), code("DSH_BRIDGE_PREVIEW_DISABLED"));
  const enabled = new DshBridgeConnector({ bridgeSocket: "/not/available.sock", allowConversationPreview: true });
  for (const options of [{}, { projectId: "w", maxChars: 0 }, { projectId: "w", maxChars: 2001 }])
    await assert.rejects(enabled.readConversation("s", options), code("DSH_BRIDGE_INVALID_INPUT"));
});
test("scoped client reply previews preserve exact metadata and clip only the approved text", async (t) => {
  const values = host();
  values.sessionQuery.listEvents = async (sessionId) => [
    { sessionId, seq: 2, type: "assistant/message", time: 3000, surface: "current" },
  ];
  values.sessionQuery.readEvent = async () => ({
    session: { id: "session-one" },
    target: {
      seq: 2,
      type: "assistant/message",
      time: 3000,
      data: {
        message: {
          content: [
            { type: "text", text: "🙂可见回复" },
            { type: "reasoning", text: "private-thought" },
          ],
        },
      },
    },
  });
  const at = await plugin(t, values, { allowReplyPreview: true });
  const connector = new DshBridgeConnector({ bridgeSocket: at.socket, allowConversationPreview: true });
  t.after(() => connector.close());
  const r = await connector.readConversation("session-one", { projectId: "workspace-one", maxChars: 3 });
  assert.equal(r.latestReply.text, "🙂可见");
  assert.equal(r.latestReply.truncated, true);
  assert.equal(r.latestReply.at, "1970-01-01T00:00:03.000Z");
  assert.equal(r.projectId, "workspace-one");
  assert.equal(r.state, "running");
  assert.equal(r.title, "");
  assert.equal(r.updatedAt, null);
  assert.ok(!JSON.stringify(r).includes("private-thought"));
  await assert.rejects(
    connector.readConversation("session-one", { projectId: "another" }),
    code("DSH_BRIDGE_PROJECT_MISMATCH"),
  );
  assert.equal((await connector.readWork("session-one")).latestReply, undefined);
});
test("old plugins explicitly reject reply capability rather than appearing to have no replies", async (t) => {
  const at = await fakeServer(t, (request, channel) =>
    channel.end(
      JSON.stringify(
        request.method === "workspace/list"
          ? { id: request.id, ok: true, result: envelope({ items: [workspace()] }) }
          : { id: request.id, ok: false, error: { code: "METHOD_NOT_ALLOWED" } },
      ) + "\n",
    ),
  );
  const connector = new DshBridgeConnector({ bridgeSocket: at.socket, allowConversationPreview: true });
  t.after(() => connector.close());
  await assert.rejects(connector.readConversation("s", { projectId: "w" }), code("DSH_BRIDGE_PREVIEW_UNSUPPORTED"));
});
test("reply source Host changes and post-read workspace moves cannot leak the response", async (t) => {
  for (const fault of ["host", "membership"]) {
    let directories = 0;
    const at = await fakeServer(t, (request, channel) => {
      let value;
      if (request.method === "workspace/list") {
        directories++;
        value = envelope({
          items: [{ ...workspace(), sessionIds: fault === "membership" && directories > 1 ? [] : ["s"] }],
        });
      } else
        value = {
          ...envelope(session()),
          latestReply: { text: "private-reply", at: null, id: "1", seq: 1, phase: null, truncated: false },
          ...(fault === "host" ? { bridgeInstance: "different" } : {}),
        };
      channel.end(JSON.stringify({ id: request.id, ok: true, result: value }) + "\n");
    });
    const connector = new DshBridgeConnector({ bridgeSocket: at.socket, allowConversationPreview: true });
    t.after(() => connector.close());
    await assert.rejects(
      connector.readConversation("s", { projectId: "w" }),
      code(fault === "host" ? "DSH_BRIDGE_HOST_CHANGED" : "DSH_BRIDGE_PROJECT_MISMATCH"),
    );
  }
});
