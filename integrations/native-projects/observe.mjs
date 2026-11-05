import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

// Native observation is cheap; only an acknowledged state change becomes a model wakeup.
export function observationEvent(subject, snapshot) {
  const project = snapshot.project;
  const fields = {
    provider: project.provider,
    host: project.host,
    nativeId: project.nativeId,
    projectKey: project.key,
    tasks: snapshot.tasks.items
      .map((t) => ({
        nativeId: t.nativeId,
        state: t.state,
        nativeState: t.nativeState,
        updatedAt: ["running", "queued", "busy"].includes(t.state) ? null : (t.updatedAt ?? null),
        membership: t.membership ?? null,
      }))
      .sort((a, b) => a.nativeId.localeCompare(b.nativeId)),
    complete: snapshot.tasks.complete,
  };
  const digest = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  return {
    id: `native-${subject}-${digest}`,
    type: `native.project.${subject}.changed`,
    subject,
    summary: "原生项目状态有变化，请核实目标与当前事实后决定是否推进",
    detail: JSON.stringify(fields),
    fingerprint: digest,
  };
}
function saveCheckpoint(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + ".tmp";
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

export async function publishObservation(subject, snapshot, checkpointFile, emit) {
  const event = observationEvent(subject, snapshot);
  let checkpoint = { sequence: 0 };
  try {
    checkpoint = JSON.parse(readFileSync(checkpointFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!checkpoint.pending && checkpoint.fingerprint === event.fingerprint) return { changed: false, emitted: false };
  // Persist an outbox before sending. A lost acknowledgement reuses this exact transition ID.
  if (!checkpoint.pending) {
    const sequence = (checkpoint.sequence ?? 0) + 1;
    const { fingerprint, ...payload } = event;
    payload.id = `native-${subject}-${sequence}-${fingerprint}`;
    checkpoint.pending = { sequence, fingerprint, payload, observedAt: snapshot.observedAt };
    saveCheckpoint(checkpointFile, checkpoint);
  }
  const pending = checkpoint.pending;
  const acknowledgement = await emit(pending.payload);
  if (!acknowledgement || !Number.isInteger(acknowledgement.event)) throw new Error("EVENT_NOT_ACKNOWLEDGED");
  saveCheckpoint(checkpointFile, {
    sequence: pending.sequence,
    fingerprint: pending.fingerprint,
    event: acknowledgement.event,
    observedAt: pending.observedAt,
  });
  return {
    changed: true,
    emitted: acknowledgement.duplicate !== true,
    acknowledged: true,
    event: acknowledgement.event,
    duplicate: acknowledgement.duplicate === true,
    pendingNewerObservation: pending.fingerprint !== event.fingerprint,
  };
}
