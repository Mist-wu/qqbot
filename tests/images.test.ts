import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LOG_LEVEL = "silent";

const { ImageDescriber } = await import("../src/chat/images.js");

const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n")]);
let downloads = 0;
globalThis.fetch = (async () => {
  downloads++;
  return new Response(PNG, { status: 200 });
}) as typeof fetch;

const picture = (file: string) => ({ type: "image", data: { file, url: `https://img.example/${file}`, sub_type: 0 } });

test("pictures are described once per file", async () => {
  downloads = 0;
  const seen: string[] = [];
  const describer = new ImageDescriber(async (url) => {
    seen.push(url.slice(0, 22));
    return "一张手机设置页面的截图（图中无文字）";
  });
  const [a, b] = await Promise.all([describer.observe(picture("x.png")), describer.observe(picture("x.png"))]);
  assert.equal(a, "一张手机设置页面的截图");
  assert.equal(b, a);
  assert.equal(downloads, 1);
  assert.deepEqual(seen, ["data:image/png;base64,"]);
});

test("failures and missing urls yield no description", async () => {
  const describer = new ImageDescriber(async () => {
    throw new Error("vision down");
  });
  assert.equal(await describer.observe(picture("y.png")), undefined);
  assert.equal(await describer.observe({ type: "image", data: {} }), undefined);
});
