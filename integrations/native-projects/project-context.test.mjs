// A project introduction must survive long chronological logs without leaking another root or granting execution.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProjectContext, projectDiscoveryHints } from "./project-context.mjs";
test("brief and decisions accompany live context with source fingerprints and explicit truncation", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "project-brief-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "docs/project_memory"), { recursive: true });
  writeFileSync(
    path.join(root, "docs/project_memory/COORDINATOR_BRIEF.md"),
    "总体目标：采集底座。\n已接通公开来源。下一段为浏览器真实接口。",
  );
  writeFileSync(path.join(root, "docs/project_memory/ACTIVE_CONTEXT.md"), "最新变化" + "x".repeat(9000));
  writeFileSync(
    path.join(root, "docs/project_memory/DECISIONS.md"),
    "已决定：不重做原有采集器\n" + "x".repeat(9000) + "\n最新决定：先接真实后端",
  );
  const c = readProjectContext(root);
  assert.equal(c.documents[0].file, "docs/project_memory/COORDINATOR_BRIEF.md");
  assert(c.documents.some((d) => d.text.includes("不重做原有采集器")));
  assert(c.documents.some((d) => d.text.includes("最新决定：先接真实后端")));
  assert(c.documents.find((d) => d.file.endsWith("ACTIVE_CONTEXT.md")).truncated);
  assert.match(c.documents[0].sha256, /^[a-f0-9]{64}$/);
  writeFileSync(path.join(root, "docs/project_memory/COORDINATOR_BRIEF.md"), "目标已改为来源质量核验");
  assert.notEqual(readProjectContext(root).documents[0].sha256, c.documents[0].sha256);
});
test("discovery uses registered roots only, skips links outside them and returns labels without local paths", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "project-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, "project");
  mkdirSync(child);
  writeFileSync(path.join(child, "README.md"), "# 数据底座\n这是跨平台采集底座，维护采集任务与来源证据。");
  writeFileSync(path.join(root, "secret.md"), "FOREIGN_PRIVATE");
  symlinkSync(path.join(root, "secret.md"), path.join(child, "AGENTS.md"));
  const hints = projectDiscoveryHints([{ alias: "C-0000000001", roots: [child] }]);
  assert.match(hints["C-0000000001"], /采集底座/);
  assert.doesNotMatch(JSON.stringify(hints), /FOREIGN_PRIVATE|\/tmp\/|\/private\//);
  assert.deepEqual(projectDiscoveryHints([{ alias: "C-0000000002", roots: [] }]), {});
});

test("a registered multi-root container can describe direct subprojects without following directory links", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "project-modules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const container = path.join(root, "container"),
    other = path.join(root, "other"),
    outside = path.join(root, "outside");
  for (const d of [path.join(container, "capture-foundation"), other, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(container, "capture-foundation", "AGENTS.md"), "采集底座：统一来源和采集任务");
  writeFileSync(path.join(outside, "AGENTS.md"), "FOREIGN_PROJECT");
  symlinkSync(outside, path.join(container, "linked-module"));
  const hints = projectDiscoveryHints([{ alias: "C-0000000001", roots: [container, other] }]);
  assert.match(hints["C-0000000001"], /采集底座/);
  assert.match(hints["C-0000000001"], /capture-foundation/);
  assert.doesNotMatch(hints["C-0000000001"], /FOREIGN_PROJECT/);
});
