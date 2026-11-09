// File contents describe a project; they never select roots, grant permission or authorize a mutation.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { redact } from "./project-activity.mjs";
const files = [
  ["docs/project_memory/COORDINATOR_BRIEF.md", 12000],
  ["docs/project_memory/ACTIVE_CONTEXT.md", 6400],
  ["docs/project_memory/DECISIONS.md", 6400],
  ["AGENTS.md", 4000],
  ["README.md", 2000],
];
export function readProjectContext(cwd, { discovery = false } = {}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return { documents: [], missingBrief: true };
  const root = realpathSync(cwd),
    documents = [];
  for (const [relative, limit] of files) {
    if (discovery && ![files[0][0], "AGENTS.md", "README.md"].includes(relative)) continue;
    let fd;
    try {
      const expected = path.join(root, relative);
      if (realpathSync(expected) !== expected) continue;
      fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) continue;
      const b = Buffer.alloc(Math.min(stat.size, discovery ? 1800 : limit));
      const n = readSync(fd, b, 0, b.length, 0);
      let captured = b.subarray(0, n),
        selection = "prefix";
      if (!discovery && relative.endsWith("DECISIONS.md") && stat.size > limit) {
        const tail = Buffer.alloc(Math.floor(limit / 2));
        const count = readSync(fd, tail, 0, tail.length, stat.size - tail.length);
        captured = Buffer.concat([
          b.subarray(0, Math.floor(limit / 2)),
          Buffer.from("\n[中间内容省略]\n"),
          tail.subarray(0, count),
        ]);
        selection = "head-and-tail";
      }
      documents.push({
        file: relative,
        text: redact(captured.toString("utf8")),
        truncated: stat.size > n,
        selection,
        modifiedAt: stat.mtime.toISOString(),
        // Fingerprint of the captured bytes, not a claim that a truncated file was read in full.
        sha256: createHash("sha256").update(captured).digest("hex"),
      });
      if (discovery && relative === files[0][0]) break;
    } catch (e) {
      if (!["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(e.code)) throw e;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return { documents, missingBrief: !documents.some((d) => d.file === files[0][0]) };
}
export function projectDiscoveryHints(projects) {
  const result = {};
  for (const p of projects.slice(0, 100)) {
    if (!/^[CMD]-[a-f0-9]{10}$/i.test(p.alias ?? "") || !Array.isArray(p.roots)) continue;
    const roots = [...new Set(p.roots.filter((r) => typeof r === "string" && path.isAbsolute(r)))];
    if (!roots.length || roots.length > 3) continue;
    try {
      const parts = [];
      for (const registered of roots) {
        const root = realpathSync(registered),
          { documents } = readProjectContext(root, { discovery: true });
        if (documents.length)
          parts.push(
            documents
              .map((d) => d.text)
              .join(" ")
              .slice(0, 900),
          );
        else {
          // A registered container may hold several repos. Read only direct child introductions, never recurse into data.
          for (const entry of readdirSync(root, { withFileTypes: true })
            .filter(
              (e) =>
                e.isDirectory() &&
                !e.name.startsWith(".") &&
                !/(?:backup|archive|归档|备份)/i.test(e.name) &&
                !["node_modules", "outputs", "runtime", "work", "dist", "build", "vendor"].includes(e.name),
            )
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 48)) {
            const child = path.join(root, entry.name);
            if (realpathSync(child) !== child) continue;
            const docs = readProjectContext(child, { discovery: true }).documents;
            if (docs.length)
              parts.push(
                "子项目 " +
                  entry.name +
                  "：" +
                  docs
                    .map((d) => d.text)
                    .join(" ")
                    .slice(0, 200),
              );
            if (parts.length >= 6) break;
          }
        }
      }
      const hint = parts
        .join(" | ")
        .replace(/```[\s\S]*?(?:```|$)/gu, " ")
        .replace(/https?:\/\/\S+|(?:~\/|\/(?:Users|Volumes|private|tmp)\/)\S+/giu, " ")
        .replace(/[\p{Cc}\p{Cf}`<>]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
      if (hint) result[p.alias] = [...hint].slice(0, 600).join("");
    } catch {
      /* Unavailable project roots must not delay or authorize catalogue navigation. */
    }
  }
  return result;
}
