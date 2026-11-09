// Publish a reviewed artifact report to the configured group. Deployment authority comes from the caller's verified receipt.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, realpathSync, lstatSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const fail = (code) => Object.assign(new Error(code), { code });
function plain(value, max = 700) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|\/(?:Users|Volumes|private|tmp)\/|Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{16,}/u.test(
      value,
    )
  )
    throw fail("PREVIEW_TEXT_INVALID");
  return value.trim();
}
function list(values) {
  if (!Array.isArray(values) || !values.length || values.length > 8) throw fail("PREVIEW_REPORT_INCOMPLETE");
  return values.map((x) => plain(x, 300));
}
export function verifyPreviewImages(root, entries) {
  if (
    !path.isAbsolute(root) ||
    realpathSync(root) !== root ||
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > 4
  )
    throw fail("PREVIEW_IMAGES_INVALID");
  return entries.map((x) => {
    if (typeof x.path !== "string" || path.isAbsolute(x.path)) throw fail("PREVIEW_IMAGE_SCOPE");
    const file = path.resolve(root, x.path);
    if (!file.startsWith(root + path.sep) || realpathSync(file) !== file) throw fail("PREVIEW_IMAGE_SCOPE");
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 10 * 1024 * 1024) throw fail("PREVIEW_IMAGE_INVALID");
    const bytes = readFileSync(file);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw fail("PREVIEW_IMAGE_INVALID");
    if (!/^[a-f0-9]{64}$/.test(x.sha256 ?? "") || hash(bytes) !== x.sha256) throw fail("PREVIEW_IMAGE_CHANGED");
    return { path: x.path, file, sha256: x.sha256, caption: plain(x.caption, 100) };
  });
}
export function buildPreviewPost(
  report,
  { deployment, expectedProjectId, expectedOrigin, ownerId, accessNote, images },
) {
  if (deployment?.status !== "succeeded" || deployment.project_id !== expectedProjectId)
    throw fail("PREVIEW_DEPLOYMENT_UNVERIFIED");
  const url = new URL(deployment.url);
  if (url.protocol !== "https:" || url.origin !== expectedOrigin || url.username || url.password || url.search)
    throw fail("PREVIEW_URL_INVALID");
  if (
    !/^ou_[A-Za-z0-9_-]+$/.test(ownerId ?? "") ||
    !Array.isArray(images) ||
    images.length < 1 ||
    images.some((x) => !/^img_[A-Za-z0-9_-]+$/.test(x.key))
  )
    throw fail("PREVIEW_RECIPIENT_OR_IMAGES_INVALID");
  const title = plain(report.projectName, 100) + " · " + plain(report.title, 100),
    text = (v, bold = false) => ({ tag: "text", text: v, ...(bold ? { style: ["bold"] } : {}) });
  const content = [
    [{ tag: "at", user_id: ownerId }, text(" 本轮成果可以查看了")],
    [{ tag: "a", text: "打开测试预览", href: url.href }],
    [text(plain(accessNote, 300))],
    [text(plain(report.summary))],
    [text("建议这样看", true)],
    ...list(report.steps).map((x, i) => [text(`${i + 1}. ${x}`)]),
  ];
  for (const image of images) content.push([text(plain(image.caption, 100))], [{ tag: "img", image_key: image.key }]);
  for (const [label, items] of [
    ["已经可以操作", report.working],
    ["本轮演示范围", report.demo],
    ["还没接好或尚未验证", report.missing],
    ["请重点看", report.reviewFocus],
  ])
    content.push([text(label, true)], ...list(items).map((x) => [text("• " + x)]));
  content.push(
    [text("接下来：" + plain(report.nextStep, 300))],
    [text("你可以直接回复这条消息提意见。普通调整继续处理，重大取舍再请你决定。")],
  );
  return { zh_cn: { title, content } };
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
      (e, stdout, stderr) => resolve({ exitCode: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }),
    );
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
function ok(r) {
  let j;
  try {
    j = JSON.parse(r.stdout || r.stderr);
  } catch {
    throw fail("PREVIEW_LARK_RESPONSE_UNKNOWN");
  }
  if (r.exitCode !== 0 || j.ok !== true) throw fail("PREVIEW_LARK_REQUEST_FAILED");
  return j.data;
}
export async function deliverPreview(
  { config, report, deployment, expectedProjectId, expectedOrigin, accessNote, artifactRoot, screenshots, stateFile },
  { run = execute } = {},
) {
  if (
    !/^oc_[A-Za-z0-9_-]+$/.test(config.chatId ?? "") ||
    config.allowedSenderIds?.length !== 1 ||
    !path.isAbsolute(config.larkCommand ?? "") ||
    !config.profile
  )
    throw fail("PREVIEW_DESTINATION_INVALID");
  if (!path.isAbsolute(stateFile) || path.resolve(stateFile).startsWith(artifactRoot + path.sep))
    throw fail("PREVIEW_STATE_INVALID");
  const images = verifyPreviewImages(artifactRoot, screenshots),
    fingerprint = hash(
      JSON.stringify([
        config.profile,
        config.chatId,
        config.allowedSenderIds[0],
        accessNote,
        expectedProjectId,
        deployment.id,
        deployment.version_id,
        deployment.url,
        report,
        images.map((x) => [x.path, x.sha256, x.caption]),
      ]),
    );
  mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  if (existsSync(stateFile) && (lstatSync(stateFile).isSymbolicLink() || !lstatSync(stateFile).isFile()))
    throw fail("PREVIEW_STATE_INVALID");
  let state = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { fingerprint, images: {}, deliveryKey: "pl-preview-" + fingerprint.slice(0, 36) };
  if (state.fingerprint !== fingerprint) throw fail("PREVIEW_DELIVERY_CHANGED");
  const save = () => {
    writeFileSync(stateFile + ".tmp", JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(stateFile + ".tmp", stateFile);
  };
  const call = (args, input) =>
    run(config.larkCommand, ["--profile", config.profile, ...args, "--as", "bot"], { cwd: artifactRoot, input });
  // Validate the whole human report before the first external upload.
  buildPreviewPost(report, {
    deployment,
    expectedProjectId,
    expectedOrigin,
    ownerId: config.allowedSenderIds[0],
    accessNote,
    images: images.map((x, i) => ({ ...x, key: "img_check_" + i })),
  });
  for (const image of images) {
    if (state.images[image.sha256]) continue;
    verifyPreviewImages(artifactRoot, [image]);
    const data = ok(
      await call(["im", "images", "create", "--data", JSON.stringify({ image_type: "message" }), "--file", image.path]),
    );
    if (!/^img_[A-Za-z0-9_-]+$/.test(data?.image_key ?? "")) throw fail("PREVIEW_IMAGE_UPLOAD_UNKNOWN");
    state.images[image.sha256] = data.image_key;
    save();
  }
  const post = buildPreviewPost(report, {
    deployment,
    expectedProjectId,
    expectedOrigin,
    ownerId: config.allowedSenderIds[0],
    accessNote,
    images: images.map((x) => ({ ...x, key: state.images[x.sha256] })),
  });
  if (!state.messageId) {
    save();
    const data = ok(
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
          state.deliveryKey,
        ],
        JSON.stringify(post),
      ),
    );
    if (!/^om_[A-Za-z0-9_-]+$/.test(data?.message_id ?? "") || (data.chat_id && data.chat_id !== config.chatId))
      throw fail("PREVIEW_MESSAGE_UNKNOWN");
    state.messageId = data.message_id;
    save();
  }
  const data = ok(await call(["im", "+messages-mget", "--message-ids", state.messageId, "--no-reactions"]));
  const message = data?.messages?.find(
    (x) => x.message_id === state.messageId && x.chat_id === config.chatId && !x.deleted,
  );
  const remote = JSON.stringify(message);
  if (!message || !remote.includes(deployment.url) || images.some((x) => !remote.includes(state.images[x.sha256])))
    throw fail("PREVIEW_READBACK_UNCONFIRMED");
  state.verifiedAt = new Date().toISOString();
  state.messageLink = message.message_app_link;
  state.previewUrl = deployment.url;
  state.post = post;
  state.readback = message;
  save();
  return {
    messageId: state.messageId,
    messageLink: state.messageLink,
    previewUrl: deployment.url,
    imageCount: images.length,
    verifiedAt: state.verifiedAt,
  };
}
