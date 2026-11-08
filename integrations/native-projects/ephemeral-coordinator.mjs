// Planning uses one disposable Codex CLI turn. The caller journals its attempt; this module never creates an owned thread.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { failure } from "./catalog.mjs";
import { ProjectActivity } from "./project-activity.mjs";

export async function readBoundProgress({ catalog, projectKey, projectId, cwd, threadId }) {
  const backend = catalog?.connectors?.codex;
  if (
    !backend?.rawWork ||
    typeof cwd !== "string" ||
    !path.isAbsolute(cwd) ||
    typeof projectKey !== "string" ||
    projectKey.split(":")[0] !== "codex" ||
    projectKey.split(":").at(-1) !== encodeURIComponent(projectId) ||
    !threadId
  )
    throw failure("BOUND_PROGRESS_SCOPE_MISMATCH");
  const verify = async () => {
    const thread = await backend.rawWork(threadId);
    if (
      thread?.id !== threadId ||
      thread.cwd !== cwd ||
      thread.ephemeral === true ||
      thread.archived === true ||
      (thread.projectId !== projectId && thread.projectId !== null)
    )
      throw failure("BOUND_PROGRESS_SCOPE_MISMATCH");
  };
  await verify();
  // Reuse the same project membership checks and visible-text redaction as the selected project preview.
  const snapshot = await new ProjectActivity(catalog).read(projectKey, { workId: threadId, force: true });
  await verify();
  const selected = snapshot.selected;
  if (
    snapshot.status !== "available" ||
    selected?.nativeId !== threadId ||
    !["native-project", "cwd-unassigned"].includes(selected.membership)
  )
    throw failure("BOUND_PROGRESS_UNAVAILABLE");
  const reply = selected.latestReply;
  return {
    title: selected.title,
    excerpt: reply?.text ?? null,
    at: reply?.at ?? null,
    phase: reply?.phase ?? null,
    truncated: reply?.truncated === true,
    observedAt: snapshot.observedAt,
    complete: snapshot.complete,
  };
}

const disabled = [
  "shell_tool",
  "unified_exec",
  "multi_agent",
  "apps",
  "plugins",
  "hooks",
  "memories",
  "goals",
  "default_mode_request_user_input",
  "skill_search",
  "browser_use",
  "computer_use",
  "view_image",
  "image_generation",
  "code_mode",
  "code_mode_host",
];
const args = [
  "exec",
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "-c",
  'model_provider="loop-https"',
  "-c",
  'model_providers.loop-https.name="OpenAI"',
  "-c",
  'model_providers.loop-https.wire_api="responses"',
  "-c",
  "model_providers.loop-https.requires_openai_auth=true",
  "-c",
  "model_providers.loop-https.supports_websockets=false",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "-c",
  'approval_policy="never"',
  "-c",
  'web_search="disabled"',
  "-c",
  "mcp_servers={}",
  "-c",
  'default_permissions="planning"',
  "-c",
  'permissions.planning.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
  ...disabled.flatMap((feature) => ["--disable", feature]),
  "-",
];
const MAX_LINE = 1048576;
function readUsage(raw) {
  const turnUsage = {};
  for (const [key, field] of [
    ["input", "input_tokens"],
    ["output", "output_tokens"],
    ["cached", "cached_input_tokens"],
  ]) {
    if (Number.isSafeInteger(raw?.[field]) && raw[field] >= 0) turnUsage[key] = raw[field];
  }
  const count = Object.keys(turnUsage).length;
  return { ...(count && { turnUsage }), turnUsageStatus: count === 3 ? "complete" : count ? "partial" : "missing" };
}

// Only the process result may authorize a downstream model action. A deadline, partial output, or second turn fails closed.
export async function runEphemeralCoordinator({
  command,
  prompt,
  timeoutMs = 600000,
  signal,
  beforeStart,
  classificationOnly = false,
}) {
  if (
    !path.isAbsolute(command ?? "") ||
    typeof prompt !== "string" ||
    !prompt.trim() ||
    Buffer.byteLength(prompt) > 120000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 1800000
  )
    throw failure("EPHEMERAL_COORDINATOR_INVALID");
  const checkAbort = () => {
    if (signal?.aborted) throw failure("EPHEMERAL_COORDINATOR_ABORTED");
  };
  checkAbort();
  const startedAt = Date.now();
  const dir = await mkdtemp(path.join(tmpdir(), "personal-loop-planning-"));
  try {
    if (beforeStart) await beforeStart();
    checkAbort();
    return await new Promise((resolve, reject) => {
      const cliArgs =
        classificationOnly === true ? ["exec", "-c", 'model_reasoning_effort="low"', ...args.slice(1)] : args;
      const child = spawn(command, cliArgs, {
        cwd: dir,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stopCode,
        killTimer,
        partial = "",
        answer,
        usage,
        started = false,
        completed = false;
      const kill = (sig) => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(sig);
          else process.kill(-child.pid, sig);
        } catch (error) {
          if (error.code !== "ESRCH") child.kill(sig);
        }
      };
      const stop = (code) => {
        if (stopCode) return;
        stopCode = code;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 750);
      };
      const abort = () => stop("EPHEMERAL_COORDINATOR_ABORTED");
      const timer = setTimeout(() => stop("EPHEMERAL_COORDINATOR_TIMEOUT"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const consume = (line) => {
        if (!line.trim() || stopCode) return;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          return stop("EPHEMERAL_COORDINATOR_PROTOCOL");
        }
        if (!e || typeof e.type !== "string") return stop("EPHEMERAL_COORDINATOR_PROTOCOL");
        if (e.type === "turn.started") {
          if (started) return stop("EPHEMERAL_COORDINATOR_PROTOCOL");
          started = true;
        } else if (e.type === "turn.failed") stop("EPHEMERAL_COORDINATOR_FAILED");
        else if (e.type === "turn.completed") {
          // CLI capability diagnostics can precede turn.started. They are neither a tool call nor a final answer.
          if (e.item?.type === "error") return;
          if (!started || completed) return stop("EPHEMERAL_COORDINATOR_PROTOCOL");
          completed = true;
          usage = readUsage(e.usage);
        } else if (e.type === "item.started" || e.type === "item.completed") {
          // CLI capability diagnostics can precede turn.started. They are neither a tool call nor a final answer.
          if (e.item?.type === "error") return;
          if (!started || completed) return stop("EPHEMERAL_COORDINATOR_PROTOCOL");
          if (!["agent_message", "reasoning"].includes(e.item?.type)) return stop("EPHEMERAL_COORDINATOR_TOOL_DENIED");
          if (e.type === "item.completed" && e.item.type === "agent_message" && typeof e.item.text === "string")
            answer = e.item.text;
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (stopCode) return;
        const lines = (partial + chunk).split("\n");
        partial = lines.pop();
        if (Buffer.byteLength(partial) > MAX_LINE || lines.some((l) => Buffer.byteLength(l) > MAX_LINE))
          return stop("EPHEMERAL_COORDINATOR_PROTOCOL");
        for (const line of lines) consume(line);
      });
      child.stderr.resume();
      child.once("error", () => stop("EPHEMERAL_COORDINATOR_SPAWN_FAILED"));
      child.stdin.on("error", () => stop("EPHEMERAL_COORDINATOR_INPUT_FAILED"));
      child.once("close", (code) => {
        if (!stopCode && partial) consume(partial);
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        if (stopCode) {
          kill("SIGKILL");
          return reject(failure(stopCode));
        }
        if (code !== 0 || !completed || !answer?.trim()) return reject(failure("EPHEMERAL_COORDINATOR_INCOMPLETE"));
        resolve({ text: answer, ...usage });
      });
      child.stdin.end(prompt);
    });
  } catch (error) {
    // Persist only operational metadata, never prompts, model output or credentials.
    process.stderr.write(
      JSON.stringify({
        event: "ephemeral-coordinator-failed",
        code: /^EPHEMERAL_COORDINATOR_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "COORDINATOR_UNAVAILABLE",
        elapsedMs: Date.now() - startedAt,
        classificationOnly,
      }) + "\n",
    );
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
