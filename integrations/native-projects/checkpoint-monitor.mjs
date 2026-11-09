// Message checkpoints are separate from whole-task completion. This module never starts or steers the native conversation.
import { createHash } from "node:crypto";
import { readCheckpointItems, classifyCheckpoint, checkpointItemFingerprint } from "./checkpoint-source.mjs";
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const normalize = (v) => v.normalize("NFKC").replace(/[\s\p{P}]/gu, "");
const tables = `CREATE TABLE IF NOT EXISTS checkpoint_baselines(scope TEXT PRIMARY KEY,at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoint_items(scope TEXT NOT NULL,item_key TEXT NOT NULL,source_hash TEXT NOT NULL,at INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,event TEXT,PRIMARY KEY(scope,item_key));
CREATE TABLE IF NOT EXISTS checkpoint_topics(scope TEXT NOT NULL,topic TEXT NOT NULL,event_key TEXT NOT NULL,PRIMARY KEY(scope,topic));`;
export async function pollCheckpointTarget({
  db,
  o,
  n,
  target,
  scope,
  now,
  guard,
  runtime,
  onCheckpoint,
  readItems = readCheckpointItems,
  classify = classifyCheckpoint,
  signal,
  hasResultNotice = () => false,
  hasManagedDecisionOwner = () => false,
}) {
  db.exec(tables);
  const since = Date.parse(o.checkpointEnabledAt);
  if (!Number.isFinite(since) || since > now()) throw Error("Invalid checkpoint start");
  const itemScope = hash([scope, o.checkpointEnabledAt]);
  const baseline = db.prepare("SELECT at FROM checkpoint_baselines WHERE scope=?").get(itemScope)?.at;
  const batch = await readItems(n, target, { since: Math.max(since, now() - 30 * 60000), now: now() });
  guard();
  if (!Array.isArray(batch?.items)) throw Error("Invalid checkpoint snapshot");
  const rows = batch.items.filter((v) => v.at >= since && v.at <= now());
  const keyOf = (v) => hash([v.turnId, v.itemId]);
  const checksum = checkpointItemFingerprint;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO checkpoint_items(scope,item_key,source_hash,at,state) VALUES(?,?,?,?,?)",
  );
  if (baseline === undefined) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of rows) insert.run(itemScope, keyOf(item), checksum(item), item.at, "baseline");
      db.prepare("INSERT OR IGNORE INTO checkpoint_baselines VALUES(?,?)").run(itemScope, now());
      db.exec("COMMIT");
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
    return { baselined: 1, sent: 0, pending: 0, sampled: rows.length };
  }
  let classified = 0,
    sent = 0,
    pending = 0;
  for (const item of rows) {
    const key = keyOf(item),
      sourceHash = checksum(item);
    if (item.at < baseline) continue;
    // The regular run receipt already reports its own final answer. Interim checkpoints remain eligible.
    const ownFinal = item.phase === "final_answer" && hasResultNotice(n, target, item);
    insert.run(itemScope, key, sourceHash, item.at, ownFinal ? "owned-final" : "new");
    let row = db.prepare("SELECT * FROM checkpoint_items WHERE scope=? AND item_key=?").get(itemScope, key);
    if (row.source_hash !== sourceHash) continue;
    if (row.state === "new" && row.at >= now() - 30 * 60000 && classified < 3) {
      if (row.at < baseline || row.at < since) continue;
      if (row.attempts >= 2) {
        db.prepare("UPDATE checkpoint_items SET state='unconfirmed' WHERE scope=? AND item_key=?").run(itemScope, key);
        continue;
      }
      db.prepare("UPDATE checkpoint_items SET attempts=attempts+1 WHERE scope=? AND item_key=?").run(itemScope, key);
      classified++;
      const verdict = await classify(item, { command: n.managedCodex.command, signal, beforeStart: guard });
      guard();
      if (!verdict) continue;
      if (verdict.kind === "ignore")
        db.prepare("UPDATE checkpoint_items SET state='ignored' WHERE scope=? AND item_key=?").run(itemScope, key);
      else {
        const topic = hash([
          item.turnId,
          verdict.kind,
          normalize(verdict.topic),
          ...(verdict.kind === "milestone" ? [] : [verdict.question, verdict.options ?? []]),
        ]);
        const eventKey = "checkpoint-" + hash([itemScope, key]).slice(0, 48);
        const event = {
          projectKey: target.projectKey,
          projectName: target.projectName,
          threadId: target.threadId,
          turnId: item.turnId,
          itemId: item.itemId,
          at: item.at,
          phase: item.phase,
          sourceHash,
          kind: verdict.kind,
          topic: verdict.topic,
          summary: verdict.summary,
          evidence: verdict.evidence,
          ...(verdict.question ? { question: verdict.question } : {}),
          ...(verdict.options ? { options: verdict.options } : {}),
          ...(verdict.recommend !== undefined ? { recommend: verdict.recommend, reason: verdict.reason } : {}),
          ...(item.questions?.length ? { nativeQuestions: item.questions } : {}),
          eventKey,
          scope,
          itemScope,
        };
        db.prepare("UPDATE checkpoint_items SET state='pending',event=? WHERE scope=? AND item_key=?").run(
          JSON.stringify({ topic, event }),
          itemScope,
          key,
        );
      }
      row = db.prepare("SELECT * FROM checkpoint_items WHERE scope=? AND item_key=?").get(itemScope, key);
    }
    if (row.state !== "pending") continue;
    if (item.phase === "final_answer" && hasResultNotice(n, target, item)) {
      db.prepare("UPDATE checkpoint_items SET state='owned-final' WHERE scope=? AND item_key=?").run(itemScope, key);
      continue;
    }
    const { topic, event } = JSON.parse(row.event);
    if (event.kind !== "milestone" && hasManagedDecisionOwner(n, target, item)) {
      // Keep the grounded candidate for audit, but never create a second question channel.
      // The regular small-step receipt will ask through the kernel and preserve its answer.
      db.prepare("UPDATE checkpoint_items SET state='managed' WHERE scope=? AND item_key=?").run(itemScope, key);
      continue;
    }
    const prior = db.prepare("SELECT event_key FROM checkpoint_topics WHERE scope=? AND topic=?").get(itemScope, topic);
    if (prior && prior.event_key !== event.eventKey) {
      db.prepare("UPDATE checkpoint_items SET state='duplicate' WHERE scope=? AND item_key=?").run(itemScope, key);
      continue;
    }
    guard();
    let card;
    if (event.kind === "milestone") {
      const ack = await runtime
        .layout()
        .source.tell({ key: event.eventKey, text: "「" + target.projectName + "」原对话报告：" + event.summary });
      if (!Number.isSafeInteger(ack?.card) || ack.card < 1) throw Error("Checkpoint delivery unconfirmed");
      card = ack.card;
    } else if (onCheckpoint) {
      const ack = await onCheckpoint(event);
      if (ack?.acknowledged !== true) {
        if (ack?.code === "CHECKPOINT_STALE") {
          db.prepare("UPDATE checkpoint_items SET state='stale' WHERE scope=? AND item_key=?").run(itemScope, key);
          continue;
        }
        pending++;
        continue;
      }
    } else {
      pending++;
      continue;
    }
    // Record the confirmed side effect even if authorization changed while its acknowledgement was in flight.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR IGNORE INTO checkpoint_topics VALUES(?,?,?)").run(itemScope, topic, event.eventKey);
      if (card) {
        db.prepare("INSERT OR IGNORE INTO notices VALUES(?,?)").run(event.eventKey, card);
        db.prepare("INSERT OR IGNORE INTO notice_scopes VALUES(?,?)").run(event.eventKey, scope);
      }
      db.prepare("UPDATE checkpoint_items SET state='sent' WHERE scope=? AND item_key=?").run(itemScope, key);
      db.exec("COMMIT");
      sent++;
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  }
  return { baselined: 0, sampled: rows.length, classified, sent, pending };
}
