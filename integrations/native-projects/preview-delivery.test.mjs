// Preview delivery must include inspectable artifacts, keep local paths out of messages and reject changed screenshots.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPreviewPost, verifyPreviewImages } from "./preview-delivery.mjs";
const report = {
  projectName: "公司工作台",
  title: "共享卡到检查单",
  summary: "可以连续查看并演练这段流程。",
  steps: ["查看共享卡", "生成本人草稿", "查看检查单"],
  working: ["界面交互可以完成并重置"],
  demo: ["使用合成数据，数据动作在浏览器演练"],
  missing: ["公司登录和真实执行尚未接入"],
  reviewFocus: ["入口是否容易理解"],
  nextStep: "按反馈调整这段界面",
};
const deployment = { status: "succeeded", project_id: "site-1", url: "https://preview.example.test/" };
test("a rich preview report carries link, screenshots, limits and only the configured owner mention", () => {
  const p = buildPreviewPost(report, {
    deployment,
    expectedProjectId: "site-1",
    expectedOrigin: "https://preview.example.test",
    ownerId: "ou_owner",
    accessNote: "私有测试预览，需要登录",
    images: [{ key: "img_example", caption: "正常流程" }],
  });
  const s = JSON.stringify(p);
  assert(s.includes(deployment.url) && s.includes("img_example") && s.includes("公司登录和真实执行尚未接入"));
  assert(s.includes("ou_owner"));
  assert(!s.includes("/Users/"));
  assert.throws(() =>
    buildPreviewPost(report, {
      deployment: { ...deployment, status: "building" },
      expectedProjectId: "site-1",
      expectedOrigin: "https://preview.example.test",
      images: [],
    }),
  );
  assert.throws(() =>
    buildPreviewPost(report, {
      deployment: { ...deployment, url: "https://other.test/" },
      expectedProjectId: "site-1",
      expectedOrigin: "https://preview.example.test",
      images: [],
    }),
  );
});
test("only reviewed unchanged image files beneath the approved artifact root may be uploaded", (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "preview-files-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  writeFileSync(path.join(dir, "view.png"), bytes);
  const entry = {
    path: "view.png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    caption: "真实浏览器截图",
  };
  assert.equal(verifyPreviewImages(dir, [entry]).length, 1);
  writeFileSync(path.join(dir, "view.png"), Buffer.from("changed"));
  assert.throws(() => verifyPreviewImages(dir, [entry]));
  assert.throws(() => verifyPreviewImages(dir, [{ ...entry, path: "../view.png" }]));
});

test("delivery retry reuses uploads and message identity and verifies the actual image keys", async (t) => {
  const { deliverPreview } = await import("./preview-delivery.mjs");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "preview-delivery-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { mkdirSync } = await import("node:fs");
  const assets = path.join(root, "assets");
  mkdirSync(assets);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  writeFileSync(path.join(assets, "view.png"), bytes);
  let uploads = 0,
    sends = 0,
    post;
  const args = {
    config: { chatId: "oc_original", allowedSenderIds: ["ou_owner"], larkCommand: "/fixture/lark", profile: "bot" },
    report,
    deployment: { ...deployment, id: "deployment-one", version_id: "v1" },
    expectedProjectId: "site-1",
    expectedOrigin: "https://preview.example.test",
    accessNote: "私有预览",
    artifactRoot: assets,
    screenshots: [{ path: "view.png", sha256: createHash("sha256").update(bytes).digest("hex"), caption: "当前画面" }],
    stateFile: path.join(root, "receipt.json"),
  };
  const run = async (_c, a, o) => {
    let data;
    if (a.includes("images")) {
      uploads++;
      data = { image_key: "img_saved" };
    } else if (a.includes("+messages-send")) {
      sends++;
      post = JSON.parse(o.input);
      assert(a.includes("--idempotency-key"));
      data = { message_id: "om_delivery", chat_id: "oc_original" };
    } else
      data = {
        messages: [
          {
            message_id: "om_delivery",
            chat_id: "oc_original",
            content: JSON.stringify(post),
            message_app_link: "https://applink.feishu.cn/client/chat/open?openChatId=oc_original",
          },
        ],
      };
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, data }) };
  };
  await deliverPreview(args, { run });
  await deliverPreview(args, { run });
  assert.equal(uploads, 1);
  assert.equal(sends, 1);
  await assert.rejects(deliverPreview({ ...args, accessNote: "改变后的访问说明" }, { run }), {
    code: "PREVIEW_DELIVERY_CHANGED",
  });
});
