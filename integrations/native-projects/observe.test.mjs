import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishObservation } from "./observe.mjs";
test("failed publication keeps checkpoint; identical retry is idempotent; clock-only change does not wake models", async (t) => {
  const folder = mkdtempSync(path.join(tmpdir(), "native-observe-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const checkpoint = path.join(folder, "seen.json");
  const snapshot = {
    observedAt: "2026-01-01T00:00:00Z",
    project: { key: "codex:local:p", provider: "codex", host: "local", nativeId: "p" },
    tasks: { complete: true, items: [{ nativeId: "t", state: "idle", title: "Private task title" }] },
  };
  const payloads = [];
  await assert.rejects(
    publishObservation("p", snapshot, checkpoint, async (e) => {
      payloads.push(e);
      throw new Error("lost ack");
    }),
  );
  assert.equal(existsSync(checkpoint), true);
  await publishObservation("p", snapshot, checkpoint, async (e) => {
    payloads.push(e);
    return { event: 1, duplicate: true };
  });
  assert.equal(payloads[0].id, payloads[1].id);
  assert.ok(!JSON.stringify(payloads).includes("Private task title"));
  snapshot.observedAt = "2026-01-01T00:01:00Z";
  assert.deepEqual(
    await publishObservation("p", snapshot, checkpoint, () => {
      throw new Error("must not emit");
    }),
    { changed: false, emitted: false },
  );
  snapshot.tasks.items[0].state = "running";
  assert.equal((await publishObservation("p", snapshot, checkpoint, async (e) => ({ event: 2 }))).emitted, true);
});

test("A to B to A is a new transition, while retries retain their transition ID", async (t) => {
  const folder = mkdtempSync(path.join(tmpdir(), "native-transition-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const checkpoint = path.join(folder, "seen.json");
  const snapshot = {
    observedAt: "2026-01-01T00:00:00Z",
    project: { key: "codex:local:p", provider: "codex", host: "local", nativeId: "p" },
    tasks: { complete: true, items: [{ nativeId: "t", state: "idle" }] },
  };
  const ids = [];
  const emit = async (event) => {
    ids.push(event.id);
    return { event: ids.length, duplicate: false };
  };
  await publishObservation("p", snapshot, checkpoint, emit);
  snapshot.tasks.items[0].state = "running";
  await publishObservation("p", snapshot, checkpoint, emit);
  snapshot.tasks.items[0].state = "idle";
  await publishObservation("p", snapshot, checkpoint, emit);
  assert.equal(new Set(ids).size, 3);
});
test("a duplicate acknowledgement is not reported as a newly emitted event", async (t) => {
  const folder = mkdtempSync(path.join(tmpdir(), "native-duplicate-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const snapshot = {
    observedAt: "now",
    project: { key: "codex:local:p", provider: "codex", host: "local", nativeId: "p" },
    tasks: { complete: true, items: [] },
  };
  const result = await publishObservation("p", snapshot, path.join(folder, "seen.json"), async () => ({
    event: 1,
    duplicate: true,
  }));
  assert.equal(result.emitted, false);
  assert.equal(result.acknowledged, true);
});
