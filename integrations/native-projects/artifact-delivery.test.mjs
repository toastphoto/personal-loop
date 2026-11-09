// Stage delivery cannot read outside its project, lose images on retry, or change business execution.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { captureArtifact, sendArtifact, ArtifactDelivery, verifyArtifactLink } from "./artifact-delivery.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), "stage-delivery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"),
    stateDir = path.join(root, "state"),
    id = "project-desk-v1",
    dir = path.join(cwd, "outputs/feishu-deliveries", id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { mode: 0o700 });
  const image = Buffer.from([255, 216, 255, 224, 0, 1]);
  writeFileSync(path.join(dir, "screen.png"), image);
  const manifest = {
    schemaVersion: 1,
    id,
    title: "项目工作桌已可查看",
    summary: "已打通资料到成果路径",
    working: ["可以导出并找回"],
    limits: ["使用合成资料，未做多人验收"],
    nextStep: "核对跨项目返回路径",
    materialScope: "synthetic-public",
    privacyReviewed: true,
    images: [{ path: "screen.png", sha256: hash(image), caption: "本轮真实窗口截图" }],
    links: [],
  };
  const bytes = JSON.stringify(manifest);
  writeFileSync(path.join(dir, "manifest.json"), bytes);
  const config = {
    chatId: "oc_original",
    profile: "bot",
    allowedSenderIds: ["ou_owner"],
    larkCommand: "/fixture/lark",
    artifactDelivery: { enabled: true, stateDir, allowedLinkOrigins: ["https://preview.example.test"] },
  };
  const target = { projectKey: "codex:local:p", threadId: "original", root: cwd, projectName: "公司项目" };
  const item = {
    turnId: "turn",
    itemId: "message",
    at: Date.now(),
    phase: "commentary",
    text: "PROJECT_DELIVERY: " + id + " " + hash(bytes) + "\n阶段完成",
  };
  return { root, dir, stateDir, manifest, config, target, item };
}
test("only source-acknowledged stage bytes and in-scope images become an immutable delivery", (t) => {
  const f = setup(t);
  const queued = captureArtifact(f);
  assert.equal(queued.status, "queued");
  assert.equal(captureArtifact(f).status, "existing");
  const record = JSON.parse(readFileSync(queued.stateFile));
  assert.equal(record.images[0].path, "0.jpg");
  writeFileSync(path.join(f.dir, "screen.png"), "changed");
  assert.throws(() =>
    captureArtifact({
      ...f,
      config: { ...f.config, artifactDelivery: { ...f.config.artifactDelivery, stateDir: path.join(f.root, "new") } },
    }),
  );
  assert.equal(record.source.itemId, f.item.itemId);
});
test("unacknowledged changes and traversal or symlink images are refused before upload", (t) => {
  const f = setup(t);
  writeFileSync(path.join(f.dir, "manifest.json"), JSON.stringify({ ...f.manifest, title: "changed" }));
  assert.throws(() => captureArtifact(f));
  writeFileSync(path.join(f.root, "outside.jpg"), Buffer.from([255, 216, 255, 224, 0, 1]));
  symlinkSync(path.join(f.root, "outside.jpg"), path.join(f.dir, "linked.jpg"));
  for (const img of ["../outside.jpg", "linked.jpg"]) {
    const m = { ...f.manifest, images: [{ ...f.manifest.images[0], path: img }] };
    const b = JSON.stringify(m);
    writeFileSync(path.join(f.dir, "manifest.json"), b);
    assert.throws(() =>
      captureArtifact({ ...f, item: { ...f.item, text: "PROJECT_DELIVERY: " + m.id + " " + hash(b) } }),
    );
  }
});
test("readback failure reuses uploaded images and the real message instead of rerunning business or resending", async (t) => {
  const f = setup(t),
    q = captureArtifact(f);
  let uploads = 0,
    sends = 0,
    reads = 0,
    post;
  const run = async (_cmd, args, opts) => {
    let data;
    if (args.includes("images")) {
      uploads++;
      data = { image_key: "img_saved" };
    } else if (args.includes("+messages-send")) {
      sends++;
      post = JSON.parse(opts.input);
      data = { message_id: "om_saved", chat_id: "oc_original" };
    } else {
      reads++;
      data = {
        messages:
          reads === 1
            ? []
            : [
                {
                  message_id: "om_saved",
                  chat_id: "oc_original",
                  content: JSON.stringify(post),
                  message_app_link: "https://example.test/message",
                },
              ],
      };
    }
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, data }) };
  };
  await assert.rejects(sendArtifact({ config: f.config, stateFile: q.stateFile, guard() {} }, { run }));
  const r = await sendArtifact({ config: f.config, stateFile: q.stateFile, guard() {} }, { run });
  assert.equal(r.status, "delivered");
  assert.equal(uploads, 1);
  assert.equal(sends, 1);
  assert.equal(reads, 2);
  assert(JSON.stringify(post).includes("ou_owner"));
});
test("background delivery is serialized, scoped to the original and does not block other work", async (t) => {
  const f = setup(t);
  const native = {
    managedCodex: { boundChats: { [f.target.projectKey]: { threadId: f.target.threadId, root: f.target.root } } },
  };
  f.config.artifactDelivery.targets = [f.target];
  f.config.artifactDelivery.enabledAt = new Date(Date.now() - 60000).toISOString();
  let release,
    scans = 0;
  const wait = new Promise((r) => (release = r));
  const service = new ArtifactDelivery(
    { config: f.config, nativeConfig: native, readCurrent: () => ({ config: f.config, nativeConfig: native }) },
    {
      readItems: async () => {
        scans++;
        await wait;
        return { items: [] };
      },
      now: () => Date.now(),
    },
  );
  service.pulse();
  service.pulse();
  assert.equal(scans, 1);
  release();
  await service.stop();
  assert.equal(scans, 1);
});

test("links cannot target local services, credentials, or redirect to an unapproved site", async () => {
  for (const url of [
    "http://127.0.0.1:8888",
    "https://preview.example.test/?token=value",
    "https://user:pass@preview.example.test/",
  ])
    await assert.rejects(verifyArtifactLink(url, ["https://preview.example.test"]));
  await assert.rejects(
    verifyArtifactLink("https://preview.example.test/page", ["https://preview.example.test"], {
      fetcher: async () => new Response("", { status: 302, headers: { location: "https://another.example.test/" } }),
    }),
  );
  assert.equal(
    await verifyArtifactLink("https://preview.example.test/page", ["https://preview.example.test"], {
      fetcher: async () => new Response("<title>实际成果</title>"),
    }),
    "https://preview.example.test/page",
  );
});

test("lost send acknowledgement retains the same deduplication key and does not resend after its safe retry window", async (t) => {
  const f = setup(t),
    q = captureArtifact(f);
  let time = Date.now(),
    keys = [];
  const run = async (_c, args) => {
    if (args.includes("images"))
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: { image_key: "img_once" } }) };
    keys.push(args[args.indexOf("--idempotency-key") + 1]);
    return { exitCode: 1, stdout: "" };
  };
  await assert.rejects(
    sendArtifact({ config: f.config, stateFile: q.stateFile, guard() {} }, { run, now: () => time }),
  );
  time += 1000;
  await assert.rejects(
    sendArtifact({ config: f.config, stateFile: q.stateFile, guard() {} }, { run, now: () => time }),
  );
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  time += 31 * 60000;
  await assert.rejects(
    sendArtifact({ config: f.config, stateFile: q.stateFile, guard() {} }, { run, now: () => time }),
    { code: "ARTIFACT_SEND_UNKNOWN" },
  );
  assert.equal(keys.length, 2);
});

test("source binding revocation stops a pending image upload", async (t) => {
  const f = setup(t),
    q = captureArtifact(f);
  let calls = 0;
  await assert.rejects(
    sendArtifact(
      {
        config: f.config,
        stateFile: q.stateFile,
        guard() {
          throw Error("revoked");
        },
      },
      {
        run: async () => {
          calls++;
        },
      },
    ),
  );
  assert.equal(calls, 0);
});

test("a hidden receipt is accepted, while examples and user messages do not authorize publication", (t) => {
  const f = setup(t);
  const first = f.item.text.split("\n")[0];
  assert.equal(
    captureArtifact({ ...f, item: { ...f.item, text: "<!-- " + first + " -->\n本阶段成果可以查看" } }).status,
    "queued",
  );
  assert.equal(captureArtifact({ ...f, item: { ...f.item, text: "下面是示例\n" + first } }).status, "ignored");
  assert.throws(() => captureArtifact({ ...f, item: { ...f.item, phase: "user" } }), {
    code: "ARTIFACT_SOURCE_INVALID",
  });
});

test("one unavailable project does not hold up another project delivery scan", async (t) => {
  const f = setup(t);
  const bad = { ...f.target, projectKey: "codex:local:bad", threadId: "missing" };
  const native = {
    managedCodex: { boundChats: { [f.target.projectKey]: { threadId: f.target.threadId, root: f.target.root } } },
  };
  f.config.artifactDelivery.targets = [bad, f.target];
  f.config.artifactDelivery.enabledAt = new Date(Date.now() - 60000).toISOString();
  let good = 0;
  const svc = new ArtifactDelivery(
    { config: f.config, nativeConfig: native, readCurrent: () => ({ config: f.config, nativeConfig: native }) },
    {
      readItems: async (_n, target) => {
        if (target.projectKey === f.target.projectKey) good++;
        return { items: [] };
      },
    },
  );
  await svc.tick();
  assert.equal(good, 1);
});

test("backoff and unresolved deliveries remain visible instead of turning the delivery status green", async (t) => {
  const f = setup(t),
    q = captureArtifact(f);
  const native = {
    managedCodex: { boundChats: { [f.target.projectKey]: { threadId: f.target.threadId, root: f.target.root } } },
  };
  f.config.artifactDelivery.targets = [f.target];
  f.config.artifactDelivery.enabledAt = new Date(Date.now() - 60000).toISOString();
  let sends = 0;
  const svc = new ArtifactDelivery(
    { config: f.config, nativeConfig: native, readCurrent: () => ({ config: f.config, nativeConfig: native }) },
    {
      readItems: async () => ({ items: [] }),
      send: async () => {
        sends++;
        throw Object.assign(new Error("network"), { code: "ARTIFACT_REQUEST_FAILED" });
      },
    },
  );
  await svc.tick();
  await svc.tick();
  assert.equal(sends, 1);
  assert.equal(svc.status().status, "retry");
  const s = JSON.parse(readFileSync(q.stateFile));
  s.status = "needs-review";
  writeFileSync(q.stateFile, JSON.stringify(s));
  await svc.tick();
  assert.equal(svc.status().status, "needs-review");
  assert.equal(svc.status().needsReview, 1);
});
