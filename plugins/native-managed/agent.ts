import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, Reading, Usage } from "../../worker/agents.ts";

const unknown =
  "待你处理：后台执行没有留下可核实的最终结果，请先检查原生任务，不要重做。\n\n```agent-autoloop\n" +
  JSON.stringify({
    ask: [
      {
        title: "任务结果需要核实",
        text: "连接已中断或最终记录不完整，请先核实任务状态",
        options: ["已核实，保持暂停", "先暂停此目标"],
        key: "native-managed-disconnected",
        about: "不能因连接中断而重新派发已可能执行的任务",
      },
    ],
  }) +
  "\n```";
const validSession = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const usage = (value: unknown): value is Usage =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value).every(
    ([k, v]) =>
      ["input", "output", "cached", "cost"].includes(k) && typeof v === "number" && Number.isFinite(v) && v >= 0,
  );

export default {
  command(turn) {
    if (turn.command?.length !== 2 || !path.isAbsolute(turn.command[0]) || !turn.command[1])
      throw new Error("需要可信配置绝对路径与原生项目标识");
    return [
      process.execPath,
      fileURLToPath(new URL("../../integrations/native-projects/managed-worker.mjs", import.meta.url)),
      turn.command[0],
      turn.command[1],
      turn.prompt,
    ];
  },
  read(stdout, code) {
    const reading: Reading = {};
    for (const line of stdout.split("\n")) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      if (event.type === "native.started" && validSession(event.session)) {
        reading.started = true;
        reading.session = event.session;
      } else if (
        event.type === "native.result" &&
        typeof event.text === "string" &&
        event.text.trim() &&
        (event.session === undefined || validSession(event.session)) &&
        (event.usage === undefined || usage(event.usage))
      ) {
        reading.text = event.text;
        reading.finished = true;
        if (event.session) reading.session = event.session;
        delete reading.usage;
        if (event.usage) reading.usage = event.usage;
      }
    }
    if (code !== null && !reading.finished) {
      reading.text = unknown;
      reading.finished = true;
    }
    return reading;
  },
  link: (session) => `codex://threads/${session}`,
} satisfies Adapter;
