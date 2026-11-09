// This channel consumes explicit project-authored delivery markers. It never schedules or reruns project work.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { readCheckpointItems } from "./checkpoint-source.mjs";
import { redact } from "./project-activity.mjs";
const hash = (x) => createHash("sha256").update(x).digest("hex");
const fail = (code) => Object.assign(new Error(code), { code });
const marker = (text) => {
  const first = (text ?? "").split(/\r?\n/, 1)[0];
  const line = first.startsWith("<!-- ") && first.endsWith(" -->") ? first.slice(5, -4) : first;
  return /^PROJECT_DELIVERY: ([a-z0-9][a-z0-9_-]{0,79}) ([a-f0-9]{64})$/.exec(line);
};
function text(s, max = 700) {
  if (
    typeof s !== "string" ||
    !s.trim() ||
    s.length > max ||
    redact(s) !== s ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|\/(?:Users|Volumes|private|tmp)\//u.test(s)
  )
    throw fail("ARTIFACT_TEXT_INVALID");
  return s.trim();
}
function lines(a) {
  if (!Array.isArray(a) || !a.length || a.length > 8) throw fail("ARTIFACT_MANIFEST_INVALID");
  return a.map((s) => text(s, 300));
}
function readWithin(root, relative, max) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw fail("ARTIFACT_PATH_INVALID");
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || realpathSync(file) !== file) throw fail("ARTIFACT_PATH_INVALID");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const a = fstatSync(fd);
    if (!a.isFile() || a.size > max) throw fail("ARTIFACT_FILE_INVALID");
    const b = Buffer.alloc(a.size),
      n = readSync(fd, b, 0, b.length, 0),
      z = fstatSync(fd);
    if (n !== b.length || a.size !== z.size || a.mtimeMs !== z.mtimeMs) throw fail("ARTIFACT_FILE_CHANGED");
    return b;
  } finally {
    closeSync(fd);
  }
}
function privateDir(dir) {
  if (!path.isAbsolute(dir)) throw fail("ARTIFACT_STATE_INVALID");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0) throw fail("ARTIFACT_STATE_INVALID");
  return realpathSync(dir);
}
function save(file, value) {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw fail("ARTIFACT_STATE_INVALID");
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
}
function urlFor(value, origins) {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    redact(decodeURIComponent(value)) !== decodeURIComponent(value)
  )
    throw fail("ARTIFACT_LINK_SCOPE");
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || !origins.includes(u.origin))
    throw fail("ARTIFACT_LINK_SCOPE");
  return u.href;
}
export function captureArtifact({ config, target, item }) {
  const found = marker(item.text);
  if (!found) return { status: "ignored" };
  if (
    !["commentary", "partial_answer", "final_answer"].includes(item.phase) ||
    !Number.isFinite(item.at) ||
    !item.turnId ||
    !item.itemId
  )
    throw fail("ARTIFACT_SOURCE_INVALID");
  const [, id, sha256] = found,
    root = realpathSync(target.root),
    dir = path.join(root, "outputs/feishu-deliveries", id);
  if (realpathSync(dir) !== dir) throw fail("ARTIFACT_PATH_INVALID");
  const raw = readWithin(dir, "manifest.json", 32000);
  if (hash(raw) !== sha256) throw fail("ARTIFACT_MANIFEST_CHANGED");
  const m = JSON.parse(raw);
  if (
    m.schemaVersion !== 1 ||
    m.id !== id ||
    m.materialScope !== "synthetic-public" ||
    m.privacyReviewed !== true ||
    !Array.isArray(m.images) ||
    m.images.length < 1 ||
    m.images.length > 4 ||
    !Array.isArray(m.links) ||
    m.links.length > 3
  )
    throw fail("ARTIFACT_MANIFEST_INVALID");
  const report = {
    title: text(m.title, 100),
    summary: text(m.summary),
    working: lines(m.working),
    limits: lines(m.limits),
    nextStep: text(m.nextStep, 300),
  };
  text(target.projectName, 100);
  const links = m.links.map((l) => ({
    title: text(l.title, 80),
    url: urlFor(l.url, config.artifactDelivery.allowedLinkOrigins ?? []),
  }));
  const parent = privateDir(config.artifactDelivery.stateDir);
  if (parent === root || parent.startsWith(root + path.sep)) throw fail("ARTIFACT_STATE_INVALID");
  const key = hash(JSON.stringify([config.profile, config.chatId, config.allowedSenderIds, target.projectKey, id]));
  const stageDir = privateDir(path.join(parent, key));
  const stateFile = path.join(stageDir, "delivery.json");
  if (existsSync(stateFile)) {
    const old = JSON.parse(readWithin(stageDir, "delivery.json", 128000));
    if (old.manifestSha256 !== sha256) throw fail("ARTIFACT_STAGE_CHANGED");
    return { status: "existing", stateFile };
  }
  const images = m.images.map((i, index) => {
    const bytes = readWithin(dir, i.path, 10 * 1024 * 1024);
    if (!/^[a-f0-9]{64}$/.test(i.sha256 ?? "") || hash(bytes) !== i.sha256) throw fail("ARTIFACT_IMAGE_CHANGED");
    const ext = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "jpg"
        : null;
    if (!ext) throw fail("ARTIFACT_IMAGE_INVALID");
    return { bytes, path: index + "." + ext, sha256: i.sha256, caption: text(i.caption, 120) };
  });
  for (const i of images) {
    const file = path.join(stageDir, i.path);
    if (existsSync(file)) {
      if (hash(readWithin(stageDir, i.path, 10 * 1024 * 1024)) !== i.sha256) throw fail("ARTIFACT_IMAGE_CHANGED");
    } else writeFileSync(file, i.bytes, { mode: 0o600, flag: "wx" });
  }
  save(stateFile, {
    status: "queued",
    id,
    key,
    manifestSha256: sha256,
    destination: { profile: config.profile, chatId: config.chatId, ownerId: config.allowedSenderIds[0] },
    target,
    source: { turnId: item.turnId, itemId: item.itemId, at: item.at },
    report,
    links,
    images: images.map(({ bytes, ...i }) => i),
    uploaded: {},
    attempts: 0,
    nextAttemptAt: 0,
  });
  return { status: "queued", stateFile };
}
const execute = (command, args, { cwd, input = "" }) =>
  new Promise((resolve) => {
    const p = execFile(
      command,
      args,
      {
        cwd,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      },
      (e, stdout, stderr) => resolve({ exitCode: e ? 1 : 0, stdout, stderr }),
    );
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
function ok(r) {
  let j;
  try {
    j = JSON.parse(r.stdout || r.stderr);
  } catch {
    throw fail("ARTIFACT_RESPONSE_UNKNOWN");
  }
  if (r.exitCode !== 0 || j.ok !== true) throw fail("ARTIFACT_REQUEST_FAILED");
  return j.data;
}
export async function verifyArtifactLink(value, origins, { fetcher = fetch } = {}) {
  let url = urlFor(value, origins);
  for (let i = 0; i < 4; i++) {
    const r = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    if (r.status >= 300 && r.status < 400) {
      const next = r.headers.get("location");
      await r.body?.cancel();
      if (!next) break;
      url = urlFor(new URL(next, url).href, origins);
      continue;
    }
    if (r.status !== 200) {
      await r.body?.cancel();
      break;
    }
    const reader = r.body?.getReader();
    let size = 0,
      body = "";
    if (reader) {
      try {
        for (;;) {
          const x = await reader.read();
          if (x.done) break;
          size += x.value.length;
          if (size > 2 * 1024 * 1024) throw fail("ARTIFACT_LINK_INVALID");
          body += new TextDecoder().decode(x.value);
        }
      } finally {
        await reader.cancel();
      }
    }
    if (/<title[^>]*>[^<]*(?:sign in|log in)|<form[^>]+(?:login|signin)/iu.test(body)) break;
    return url;
  }
  throw fail("ARTIFACT_LINK_UNAVAILABLE");
}
function postFor(s) {
  const tx = (t) => ({ tag: "text", text: t });
  const content = [[{ tag: "at", user_id: s.destination.ownerId }, tx(" " + s.report.summary)]];
  for (const l of s.links) content.push([{ tag: "a", text: l.title, href: l.url }]);
  content.push([tx("本轮已做到")], ...s.report.working.map((x) => [tx("• " + x)]));
  for (const i of s.images) content.push([tx(i.caption)], [{ tag: "img", image_key: s.uploaded[i.sha256] }]);
  content.push(
    [tx("尚未接通或验证")],
    ...s.report.limits.map((x) => [tx("• " + x)]),
    [tx("项目Agent提出的下一步：" + s.report.nextStep)],
    [tx("可直接回复这条消息提意见；普通细节继续推进，重大取舍再请你决定。")],
  );
  return { zh_cn: { title: s.target.projectName + " · " + s.report.title, content } };
}
export async function sendArtifact(
  { config, stateFile, guard },
  { run = execute, checkLink = verifyArtifactLink, now = Date.now } = {},
) {
  const dir = realpathSync(path.dirname(stateFile)),
    s = JSON.parse(readWithin(dir, path.basename(stateFile), 128000));
  if (
    s.destination.chatId !== config.chatId ||
    s.destination.profile !== config.profile ||
    s.destination.ownerId !== config.allowedSenderIds?.[0] ||
    config.allowedSenderIds.length !== 1 ||
    !/^oc_[A-Za-z0-9_-]+$/.test(config.chatId) ||
    !/^ou_[A-Za-z0-9_-]+$/.test(s.destination.ownerId) ||
    !path.isAbsolute(config.larkCommand)
  )
    throw fail("ARTIFACT_DESTINATION_CHANGED");
  guard();
  if (s.status === "delivered") return s;
  const call = (args, input) => {
    guard();
    return run(config.larkCommand, ["--profile", config.profile, ...args, "--as", "bot"], { cwd: dir, input });
  };
  for (const i of s.images)
    if (hash(readWithin(dir, i.path, 10 * 1024 * 1024)) !== i.sha256) throw fail("ARTIFACT_IMAGE_CHANGED");
  if (!s.messageId) {
    for (const l of s.links) await checkLink(l.url, config.artifactDelivery.allowedLinkOrigins ?? []);
    for (const i of s.images) {
      if (s.uploaded[i.sha256]) continue;
      const d = ok(await call(["im", "images", "create", "--data", '{"image_type":"message"}', "--file", i.path]));
      if (!/^img_[A-Za-z0-9_-]+$/.test(d?.image_key ?? "")) throw fail("ARTIFACT_IMAGE_UPLOAD_UNKNOWN");
      s.uploaded[i.sha256] = d.image_key;
      save(stateFile, s);
    }
    // Feishu documents a one-hour UUID deduplication window; leave a margin and never replay an old uncertain send.
    if (s.sendAttemptAt && now() - s.sendAttemptAt > 30 * 60000) throw fail("ARTIFACT_SEND_UNKNOWN");
    s.sendAttemptAt ??= now();
    save(stateFile, s);
    const d = ok(
      await call(
        [
          "im",
          "+messages-send",
          "--chat-id",
          config.chatId,
          "--msg-type",
          "post",
          "--content",
          "-",
          "--idempotency-key",
          "pl-artifact-" + s.key.slice(0, 36),
        ],
        JSON.stringify(postFor(s)),
      ),
    );
    if (!/^om_[A-Za-z0-9_-]+$/.test(d?.message_id ?? "") || (d.chat_id && d.chat_id !== config.chatId))
      throw fail("ARTIFACT_MESSAGE_UNKNOWN");
    s.messageId = d.message_id;
    save(stateFile, s);
  }
  const d = ok(await call(["im", "+messages-mget", "--message-ids", s.messageId, "--no-reactions"]));
  const m = d?.messages?.find((x) => x.message_id === s.messageId && x.chat_id === config.chatId && !x.deleted),
    raw = JSON.stringify(m ?? {});
  if (
    !m ||
    !raw.includes(s.destination.ownerId) ||
    s.images.some((i) => !raw.includes(s.uploaded[i.sha256])) ||
    s.links.some((l) => !raw.includes(l.url))
  )
    throw fail("ARTIFACT_READBACK_UNCONFIRMED");
  s.status = "delivered";
  s.verifiedAt = new Date(now()).toISOString();
  s.messageLink = m.message_app_link;
  s.readback = m;
  delete s.lastError;
  save(stateFile, s);
  return s;
}
// Delivered image reports are conversational anchors, not new execution authority.
export function artifactReplySource(config, nativeConfig, ref, cut, at) {
  const a = config?.artifactDelivery;
  if (!a?.stateDir || !path.isAbsolute(a.stateDir) || !existsSync(a.stateDir)) return null;
  const stat = lstatSync(a.stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
  const dir = realpathSync(a.stateDir),
    matches = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^[a-f0-9]{64}$/.test(e.name)) continue;
    try {
      const sub = path.join(dir, e.name);
      if (realpathSync(sub) !== sub) continue;
      const s = JSON.parse(readWithin(sub, "delivery.json", 128000));
      const b = nativeConfig?.managedCodex?.boundChats?.[s.target?.projectKey];
      if (
        s.status !== "delivered" ||
        s.messageId !== ref ||
        s.readback?.message_id !== ref ||
        s.readback.chat_id !== config.chatId ||
        s.readback.deleted ||
        s.destination.profile !== config.profile ||
        s.destination.chatId !== config.chatId ||
        !config.allowedSenderIds.includes(s.destination.ownerId) ||
        !Number.isFinite(Date.parse(s.verifiedAt)) ||
        !Number.isFinite(s.sendAttemptAt) ||
        s.sendAttemptAt < cut ||
        s.sendAttemptAt > at ||
        b?.threadId !== s.target.threadId ||
        b.root !== s.target.root ||
        !a.targets?.some(
          (t) => t.projectKey === s.target.projectKey && t.threadId === s.target.threadId && t.root === s.target.root,
        )
      )
        continue;
      matches.push({
        projectKey: s.target.projectKey,
        summary: text(s.report.title, 100) + "：" + text(s.report.summary),
      });
    } catch {}
  }
  return matches.length === 1 ? matches[0] : null;
}
export class ArtifactDelivery {
  constructor(
    { config, nativeConfig, readCurrent },
    { readItems = readCheckpointItems, send = sendArtifact, now = Date.now } = {},
  ) {
    Object.assign(this, { config, nativeConfig, readCurrent, readItems, send, now });
    this.next = 0;
    this.stopping = false;
    this.pending = null;
    this.last = { status: "idle" };
  }
  guard(target) {
    if (this.stopping) throw fail("ARTIFACT_STOPPED");
    const current = this.readCurrent(),
      a = current.config.artifactDelivery,
      b = current.nativeConfig.managedCodex?.boundChats?.[target.projectKey];
    if (
      !a?.enabled ||
      a.stateDir !== this.config.artifactDelivery.stateDir ||
      current.config.chatId !== this.config.chatId ||
      current.config.profile !== this.config.profile ||
      JSON.stringify(current.config.allowedSenderIds) !== JSON.stringify(this.config.allowedSenderIds) ||
      JSON.stringify(a.allowedLinkOrigins ?? []) !==
        JSON.stringify(this.config.artifactDelivery.allowedLinkOrigins ?? []) ||
      !a.targets?.some(
        (x) => x.projectKey === target.projectKey && x.root === target.root && x.threadId === target.threadId,
      ) ||
      b?.threadId !== target.threadId ||
      b.root !== target.root
    )
      throw fail("ARTIFACT_BINDING_CHANGED");
  }
  pulse() {
    if (this.pending || this.stopping || this.now() < this.next) return;
    this.next = this.now() + 30000;
    this.pending = this.tick()
      .catch((e) => {
        this.last = { status: "error", code: e.code ?? "ARTIFACT_UNAVAILABLE" };
      })
      .finally(() => {
        this.pending = null;
      });
  }
  async tick() {
    const a = this.config.artifactDelivery;
    if (!a?.enabled) return;
    const dir = privateDir(a.stateDir);
    this.last = { status: "checking" };
    const since = Date.parse(a.enabledAt);
    if (!Number.isFinite(since) || since > this.now()) throw fail("ARTIFACT_CONFIG_INVALID");
    let discovered = 0,
      delivered = 0,
      pending = 0,
      needsReview = 0;
    for (const target of a.targets ?? []) {
      let batch;
      try {
        this.guard(target);
        batch = await this.readItems(this.nativeConfig, target, { since, now: this.now() });
        this.guard(target);
      } catch (e) {
        if (this.stopping) return;
        this.last = {
          status: "capture-error",
          code: e.code ?? "ARTIFACT_SOURCE_UNAVAILABLE",
          projectKey: target.projectKey,
        };
        continue;
      }
      for (const item of batch.items ?? []) {
        if (item.at < since || !marker(item.text)) continue;
        try {
          const q = captureArtifact({ config: this.config, target, item });
          if (q.status === "queued") discovered++;
        } catch (e) {
          this.last = { status: "capture-error", code: e.code ?? "ARTIFACT_CAPTURE_FAILED" };
        }
      }
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^[a-f0-9]{64}$/.test(e.name)) continue;
      const sub = path.join(dir, e.name);
      if (realpathSync(sub) !== sub) continue;
      const f = path.join(sub, "delivery.json");
      if (!existsSync(f)) continue;
      let s = JSON.parse(readWithin(sub, "delivery.json", 128000));
      if (s.status === "delivered") continue;
      if (s.status === "needs-review") {
        needsReview++;
        this.last = { status: "needs-review", code: s.lastError };
        continue;
      }
      if (s.nextAttemptAt > this.now()) {
        pending++;
        if (!["capture-error", "needs-review"].includes(this.last.status))
          this.last = { status: "retry", code: s.lastError };
        continue;
      }
      try {
        this.guard(s.target);
        await this.send({ config: this.config, stateFile: f, guard: () => this.guard(s.target) });
        delivered++;
      } catch (error) {
        if (this.stopping) return;
        s = JSON.parse(readWithin(sub, "delivery.json", 128000));
        s.attempts++;
        s.lastError = error.code ?? "ARTIFACT_DELIVERY_FAILED";
        s.status =
          s.attempts >= 6 || ["ARTIFACT_SEND_UNKNOWN", "ARTIFACT_BINDING_CHANGED"].includes(s.lastError)
            ? "needs-review"
            : "retry";
        s.nextAttemptAt = this.now() + Math.min(30000 * 2 ** s.attempts, 300000);
        save(f, s);
        if (s.status === "needs-review") needsReview++;
        else pending++;
        this.last = { status: s.status, code: s.lastError };
      }
    }
    if (!["capture-error", "retry", "needs-review"].includes(this.last.status))
      this.last = { status: "ready", discovered, delivered };
    this.last = {
      ...this.last,
      ...(needsReview ? { status: "needs-review" } : {}),
      discovered,
      delivered,
      pending,
      needsReview,
    };
  }
  status() {
    return { ...this.last, busy: !!this.pending };
  }
  async stop() {
    this.stopping = true;
    await this.pending;
  }
}
