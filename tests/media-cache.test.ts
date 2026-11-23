import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LOG_LEVEL = "silent";

const { MediaCache } = await import("../src/chat/media-cache.js");
const { ImageDescriber } = await import("../src/chat/images.js");
const { VoiceTranscriber } = await import("../src/chat/voices.js");

const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n")]);
let downloads = 0;
globalThis.fetch = (async () => {
  downloads++;
  return new Response(PNG, { status: 200 });
}) as typeof fetch;

const picture = (file: string) => ({ type: "image", data: { file, url: `https://img.example/${file}`, sub_type: 0 } });
const voice = (file: string) => ({ type: "record", data: { file } });

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

test("a failed picture or voice description is fetched again", async () => {
  downloads = 0;
  let images = 0;
  const pictures = new ImageDescriber(async () => {
    images++;
    if (images === 1) throw new Error("vision down");
    return "补上的描述";
  });
  assert.equal(await pictures.observe(picture("retry.png")), undefined);
  assert.equal(await pictures.observe(picture("retry.png")), "补上的描述");
  assert.equal(images, 2);
  assert.equal(await pictures.observe({ type: "image", data: {} }), undefined);

  let voices = 0;
  const transcriber = new VoiceTranscriber(
    { callAction: async () => ({ status: "ok" as const, retcode: 0, data: { base64: Buffer.from("RIFF").toString("base64") } }) },
    async () => {
      voices++;
      if (voices === 1) throw new Error("asr down");
      return "补上的转写";
    },
  );
  assert.equal(await transcriber.observe(voice("retry.amr")), undefined);
  assert.equal(await transcriber.observe(voice("retry.amr")), "补上的转写");
  assert.equal(voices, 2);
});

test("picture and voice descriptions share one small cache and evict the oldest", async () => {
  downloads = 0;
  const cache = new MediaCache(1);
  let images = 0;
  let voices = 0;
  const pictures = new ImageDescriber(async () => {
    images++;
    return "图";
  }, cache);
  const transcriber = new VoiceTranscriber(
    { callAction: async () => ({ status: "ok" as const, retcode: 0, data: { base64: Buffer.from("RIFF").toString("base64") } }) },
    async () => {
      voices++;
      return "说";
    },
    cache,
  );
  await pictures.observe(picture("a.png"));
  await transcriber.observe(voice("a.amr"));
  await pictures.observe(picture("a.png"));
  await transcriber.observe(voice("a.amr"));
  assert.equal(images, 2);
  assert.equal(voices, 2);
});
