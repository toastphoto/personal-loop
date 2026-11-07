// History is a scoped read hint, never authorization or current project evidence. Read the relay's own connection.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifiedNoticeProject } from "./bound-progress-notices.mjs";
import { redact } from "./project-activity.mjs";
import { projectAlias } from "./feishu-commands.mjs";
import { subjectFor } from "./controls.mjs";

const msg = (v) => typeof v === "string" && /^om_[A-Za-z0-9_-]{1,160}$/u.test(v);
const topicId = (v) => typeof v === "string" && /^(?:omt|om)_[A-Za-z0-9_-]{1,160}$/u.test(v);
const aliasOK = (v) => typeof v === "string" && /^[CMD]-[a-f0-9]{10}$/iu.test(v);
const empty = (basis = "none") => ({ basis, history: [] });
const digest = (v) => createHash("sha256").update(v).digest("hex").slice(0, 20);
const clip = (v) =>
  [
    ...redact(typeof v === "string" ? v : "")
      .replace(/```[\s\S]*?(?:```|$)/gu, "[代码]")
      .replace(/https?:\/\/\S+/giu, "[链接]")
      .replace(/(?:~\/|\/(?:Users|Volumes|private|tmp|home)\/)[^\s，。；、]+/gu, "[路径]")
      .replace(/\b(?:om|oc|ou|omt)_[A-Za-z0-9_-]{12,}\b/gu, "[标识]")
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .trim(),
  ]
    .slice(0, 200)
    .join("");
const aliasFor = (key) => {
  if (typeof key !== "string") return null;
  try {
    const parts = key.split(":");
    if (parts.length !== 3) return null;
    const [provider, host, nativeId] = parts.map(decodeURIComponent);
    if ([provider, host, nativeId].map(encodeURIComponent).join(":") !== key) return null;
    return projectAlias({ provider, host, nativeId });
  } catch {
    return null;
  }
};
// Never load arbitrary result payloads, full cards, file attachments or native replies.
const columns = `seq,id,delivery_ref AS ref,state,created_at AS received,
 json_extract(event_json,'$.message_id') AS eventId,json_extract(event_json,'$.sender_id') AS eventOwner,json_extract(event_json,'$.chat_id') AS eventGroup,
 json_extract(event_json,'$.sender_type') AS senderType,json_extract(event_json,'$.message_type') AS messageType,
 json_extract(event_json,'$.create_time') AS eventTime,json_extract(event_json,'$.reply_to') AS parent,
 json_extract(event_json,'$.root_id') AS root,json_extract(event_json,'$.thread_id') AS thread,
 substr(json_extract(event_json,'$.content'),1,900) AS question,
 json_extract(result_json,'$.action') AS action,json_extract(result_json,'$.ok') AS ok,
 coalesce(json_extract(result_json,'$.contextAlias'),json_extract(result_json,'$.view.project.alias')) AS alias,
 json_extract(result_json,'$.projectKey') AS projectKey,json_extract(result_json,'$.contextTopic') AS topic,
 json_extract(result_json,'$.view.kind') AS viewType,
 CASE WHEN json_type(response_json)='text' THEN substr(json_extract(response_json,'$'),1,900) END AS answer,
 CASE WHEN json_type(response_json)='object' THEN json_extract(response_json,'$.sessionId') END AS cardSession,
 CASE WHEN json_type(response_json)='object' THEN json_extract(response_json,'$.revision') END AS cardRevision`;
const week = 7 * 24 * 60 * 60000;
function documentedRow(row, actor, chat, cut, at, cardStore) {
  if (
    !row ||
    row.eventId !== row.id ||
    row.eventOwner !== actor ||
    row.eventGroup !== chat ||
    row.senderType !== "user" ||
    row.messageType !== "text"
  )
    return null;
  const when = /^\d{13}$/u.test(String(row.eventTime)) ? Number(row.eventTime) : row.received;
  if (!Number.isFinite(when) || when < cut || when > at) return null;
  let alias = row.ok === 1 ? (aliasOK(row.alias) ? row.alias : aliasFor(row.projectKey)) : null;
  let caption = row.answer;
  if (row.cardSession) {
    const s = cardStore?.get?.(row.cardSession);
    if (!s || s.actor !== actor || s.chat !== chat || s.messageId !== row.ref || s.revision !== row.cardRevision)
      alias = null;
    else if (aliasOK(s.data?.navigation?.alias)) alias = s.data.navigation.alias;
    caption = alias ? "已回复项目操作卡。" : row.viewType === "project-directory" ? "已回复项目目录。" : "已回复卡片。";
  }
  const typed = typeof row.topic === "string" && /^[A-Za-z0-9_:-]{1,80}$/u.test(row.topic) ? row.topic : null;
  const branch = topicId(row.thread) ? row.thread : msg(row.root) ? row.root : null;
  const interest = alias
    ? "project:" + alias
    : typed && !["chat", "project", "status"].includes(typed)
      ? typed
      : row.action === "projects" || row.action === "portfolio-status"
        ? "portfolio"
        : null;
  // Separate explicit IM topics even when two of them refer to the same project.
  const affinity = branch
    ? "branch:" + digest(branch) + (interest ? ":" + interest : "")
    : (interest ?? (row.action === "conversation" || typed === "chat" ? "talk:" + digest(row.id) : null));
  const history = [
    { role: "user", text: clip(row.question) },
    { role: "assistant", text: clip(caption) },
  ].filter((v) => v.text);
  return {
    alias,
    affinity,
    topic: interest ?? affinity,
    history,
    parent: row.parent,
    when,
    seq: row.seq,
    delivered: row.state === "replied" && msg(row.ref),
  };
}
function hubReply(ref, config, nativeConfig, controls, cut, at, configFile) {
  const file = nativeConfig?.loopHub?.configFile;
  if (typeof file !== "string" || !path.isAbsolute(file) || !controls) return null;
  const settings = JSON.parse(readFileSync(file, "utf8"));
  const channels = Object.entries(settings.channels ?? {}).filter(
    ([, v]) => v?.use === "feishu-group-text" && v.chatId === config.chatId && v.profile === config.profile,
  );
  if (channels.length !== 1) return null;
  const db = new DatabaseSync(path.join(path.dirname(file), "hub.db"), { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN;");
    const rows = db
      .prepare(
        `SELECT json_extract(c.data,'$.rule') AS rule,json_extract(c.data,'$.created_at') AS created,
      json_extract(c.data,'$.kind') AS kind,json_extract(c.data,'$.version') AS version,json_extract(d.data,'$.version') AS deliveryVersion,json_extract(d.data,'$.given_up') AS givenUp,json_extract(d.data,'$.error') AS deliveryError,json_extract(c.data,'$.key') AS noticeKey,json_extract(c.data,'$.id') AS cardId,json_extract(c.data,'$.fyi') AS fyi,substr(json_extract(c.data,'$.title'),1,160) AS title,
      json_extract(c.data,'$.options') AS choices,substr(json_extract(c.data,'$.text'),1,260) AS body
      FROM projections d JOIN projections c ON c.collection='cards' AND c.key=CAST(json_extract(d.data,'$.card_id') AS text)
      WHERE d.collection='deliveries' AND json_extract(d.data,'$.channel')=? AND json_extract(d.data,'$.ref')=? AND json_extract(d.data,'$.version')>=1 LIMIT 2`,
      )
      .all(channels[0][0], ref);
    if (rows.length !== 1) return null;
    const c = rows[0],
      when = Date.parse(c.created);
    if (!Number.isFinite(when) || when < cut || when > at) return null;
    const matching = controls.list().filter((r) => "native-project:" + subjectFor(r.projectKey) === c.rule);
    const noticeKey =
      c.rule === null &&
      c.kind === "notice" &&
      c.fyi === 1 &&
      c.version === c.deliveryVersion &&
      !c.givenUp &&
      !c.deliveryError &&
      verifiedNoticeProject({ configFile, config, nativeConfig, sourceKey: c.noticeKey, cardId: c.cardId });
    const alias = noticeKey ? aliasFor(noticeKey) : matching.length === 1 && aliasFor(matching[0].projectKey);
    if (!alias) return null;
    const opts = c.kind === "ask" ? JSON.parse(c.choices) : [];
    const summary = clip(
      [c.title, ...(Array.isArray(opts) ? opts.slice(0, 5) : []), c.body]
        .filter((v) => typeof v === "string")
        .join("；"),
    );
    return {
      basis: "reply",
      contextAlias: alias,
      contextTopic: "project:" + alias,
      history: [{ role: "assistant", text: summary }],
    };
  } finally {
    db.close();
  }
}

export function conversationContext(
  item,
  config,
  queue,
  { now = Date.now(), recentMs = 15 * 60000, cardStore, nativeConfig, controls, configFile } = {},
) {
  const e = item?.event;
  if (
    !e ||
    !msg(e.message_id) ||
    e.message_id !== item.id ||
    e.sender_type !== "user" ||
    e.message_type !== "text" ||
    e.chat_id !== config?.chatId ||
    !Array.isArray(config.allowedSenderIds) ||
    !config.allowedSenderIds.includes(e.sender_id) ||
    !queue?.db
  )
    return empty();
  const at = Math.min(now, /^\d{13}$/u.test(String(e.create_time)) ? Number(e.create_time) : now);
  const recentCut = now - Math.min(15 * 60000, Math.max(1, recentMs)),
    explicitCut = now - week;
  const by = (condition, params, cut, limit = 13) => {
    // Use the original event clock as the final authority; received (ingest time) only limits the SQL search.
    const rows = queue.db
      .prepare(
        "SELECT " +
          columns +
          " FROM relay_messages WHERE chat=? AND sender=? AND id<>? AND created_at>=? AND " +
          condition +
          " ORDER BY seq DESC LIMIT ?",
      )
      .all(e.chat_id, e.sender_id, item.id, cut, ...params, limit);
    return rows.map((row) => documentedRow(row, e.sender_id, e.chat_id, cut, at, cardStore)).filter(Boolean);
  };
  const find = (id) => by("(id=? OR delivery_ref=?)", [id, id], explicitCut, 2);
  const bundle = (basis, items) => {
    const sorted = [...items].sort((a, b) => a.when - b.when || a.seq - b.seq).slice(-2);
    const last = sorted.at(-1);
    return {
      basis,
      ...(last?.alias && { contextAlias: last.alias }),
      ...(last?.topic && { contextTopic: last.topic }),
      history: sorted.flatMap((v) => v.history),
    };
  };
  try {
    const direct = e.reply_to ?? e.parent_id;
    if (direct != null && direct !== "") {
      if (!msg(direct)) return empty();
      const hits = find(direct);
      if (hits.length > 1) return empty("ambiguous");
      if (!hits.length) return hubReply(direct, config, nativeConfig, controls, explicitCut, at, configFile) ?? empty();
      const row = hits[0];
      if (!row.delivered) return empty();
      const earlier = msg(row.parent) ? find(row.parent) : [];
      return bundle(
        "reply",
        earlier.length === 1 &&
          earlier[0].delivered &&
          earlier[0].when <= row.when &&
          (!row.alias || earlier[0].alias === row.alias)
          ? [earlier[0], row]
          : [row],
      );
    }
    const confined = Boolean(e.thread_id || e.root_id);
    if ((e.thread_id && !topicId(e.thread_id)) || (e.root_id && !msg(e.root_id))) return empty();
    let rows;
    if (e.thread_id) {
      rows = by("json_extract(event_json,'$.thread_id')=?", [e.thread_id], explicitCut);
    } else if (e.root_id) {
      rows = by(
        "(id=? OR delivery_ref=? OR json_extract(event_json,'$.root_id')=?)",
        [e.root_id, e.root_id, e.root_id],
        explicitCut,
      );
    } else rows = by("1", [], recentCut);
    if (!rows.length && confined && msg(e.root_id)) {
      const root = find(e.root_id);
      if (root.length === 1 && root[0].delivered) return bundle("topic", root);
      return hubReply(e.root_id, config, nativeConfig, controls, explicitCut, at, configFile) ?? empty();
    }
    if (!rows.length) return empty();
    if (rows.length >= 13 || rows.some((v) => !v.delivered || (!confined && !v.affinity))) return empty("ambiguous");
    const identities = new Set(rows.map((v) => (confined ? (v.alias ?? v.topic ?? "thread") : v.affinity)));
    if (identities.size !== 1) return empty("ambiguous");
    return bundle(confined ? "topic" : "unique-recent", rows);
  } catch {
    return empty();
  }
}
