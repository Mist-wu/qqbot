import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.LOG_LEVEL = "silent";

const { StickerStore } = await import("../src/chat/stickers.js");
const { sniffMime, cleanDescription } = await import("../src/chat/media.js");

const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
let downloads = 0;
globalThis.fetch = (async () => {
  downloads++;
  return new Response(GIF, { status: 200 });
}) as typeof fetch;

const image = (file: string) => ({ type: "image", data: { file, url: `https://img.example/${file}`, sub_type: 1 } });

async function store(max = 300, describe = async () => "猫猫叹气") {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-stickers-"));
  const instance = new StickerStore(dir, describe, max);
  await instance.load();
  return { dir, instance };
}

test("sniffs image types from bytes", () => {
  assert.equal(sniffMime(GIF), "image/gif");
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(sniffMime(Buffer.from("hello")), undefined);
});

test("collects a sticker once and reuses its description", async () => {
  downloads = 0;
  let described = 0;
  const { dir, instance } = await store(300, async () => {
    described++;
    return "猫猫叹气";
  });
  const [a, b] = await Promise.all([instance.observe(image("a.gif")), instance.observe(image("a.gif"))]);
  assert.equal(a, "猫猫叹气");
  assert.equal(b, "猫猫叹气");
  assert.equal(await instance.observe(image("a.gif")), "猫猫叹气");
  assert.equal(downloads, 1);
  assert.equal(described, 1);

  const [sticker] = instance.list();
  assert.equal(sticker!.id, 1);
  assert.equal(sticker!.seen, 2);
  const segment = await instance.toSegment(sticker!);
  assert.equal(segment.type, "image");
  assert.equal(segment.data.sub_type, 1);
  assert.equal(segment.data.file, `base64://${GIF.toString("base64")}`);

  await instance.flush();
  const saved = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  assert.equal(saved[0].used, 1);
  const reloaded = new StickerStore(dir, async () => "不该调用");
  await reloaded.load();
  assert.equal(reloaded.byId(1)?.description, "猫猫叹气");
});

test("market faces are resent as mface", async () => {
  const { instance } = await store();
  const mface = {
    type: "mface",
    data: { emoji_id: "e1", emoji_package_id: 7, key: "k", summary: "[嘻嘻]", url: "https://img.example/m.gif" },
  };
  assert.equal(await instance.observe(mface), "猫猫叹气");
  const segment = await instance.toSegment(instance.list()[0]!);
  assert.deepEqual(segment, { type: "mface", data: { emoji_id: "e1", emoji_package_id: 7, key: "k", summary: "[嘻嘻]" } });
});

test("evicts the least used sticker and its file when full", async () => {
  const { dir, instance } = await store(2);
  await instance.observe(image("a.gif"));
  await instance.observe(image("a.gif"));
  await instance.observe(image("b.gif"));
  await instance.observe(image("c.gif"));
  assert.equal(instance.size, 2);
  assert.deepEqual(
    instance.list().map((sticker) => sticker.key).sort(),
    ["image:a.gif", "image:c.gif"],
  );
  assert.equal((await readdir(dir)).filter((file) => file.endsWith(".gif")).length, 2);
});

test("failed description is not stored", async () => {
  const { instance } = await store(300, async () => "");
  assert.equal(await instance.observe(image("x.gif")), undefined);
  assert.equal(instance.size, 0);
});

test("descriptions drop remarks about missing text", () => {
  const cases: [string, string][] = [
    ["这是一个没有文字、表示开心或笑的标准黄色笑脸表情。", "这是一个表示开心或笑的标准黄色笑脸表情。"],
    ["图中无文字，这张表情包表达了极度震惊、感动或崩溃的夸张大哭。", "这张表情包表达了极度震惊、感动或崩溃的夸张大哭。"],
    ["这个表情包表达了一种面无表情、呆滞、无语或尴尬的中立情绪（图中无文字）。", "这个表情包表达了一种面无表情、呆滞、无语或尴尬的中立情绪。"],
    ["图片没有文字，它表达的是委屈地揉眼睛大哭。", "它表达的是委屈地揉眼睛大哭。"],
    ["委屈、无奈又可怜巴巴的无语感（图内无文字）。", "委屈、无奈又可怜巴巴的无语感。"],
    ["这个表情包没有文字，表达的是愤怒、咬牙切齿的情绪。", "这个表情包表达的是愤怒、咬牙切齿的情绪。"],
    ["图片文字为“上面的人是gay”，表达调侃。", "图片文字为“上面的人是gay”，表达调侃。"],
  ];
  for (const [raw, clean] of cases) assert.equal(cleanDescription(raw), clean);
});

test("stored descriptions are cleaned on load", async () => {
  const { dir, instance } = await store(300, async () => "开心（图中无文字）");
  await instance.observe(image("q.gif"));
  await instance.flush();
  const raw = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  raw[0].description = "图中无文字，一脸不爽";
  await writeFile(join(dir, "index.json"), JSON.stringify(raw));
  const reloaded = new StickerStore(dir, async () => "");
  await reloaded.load();
  assert.equal(instance.list()[0]!.description, "开心");
  assert.equal(reloaded.list()[0]!.description, "一脸不爽");
});

test("sticker list is ranked by what people post, not by the bot's own use, and shuffled", async () => {
  const { instance } = await store(300);
  for (const file of ["a.gif", "b.gif", "c.gif"]) await instance.observe(image(file));
  await instance.observe(image("b.gif"));
  await instance.observe(image("c.gif"));
  const a = instance.list().find((sticker) => sticker.key === "image:a.gif")!;
  for (let i = 0; i < 10; i++) await instance.toSegment(a);
  assert.deepEqual(instance.list(2).map((sticker) => sticker.key).sort(), ["image:b.gif", "image:c.gif"]);
  const orders = new Set(Array.from({ length: 30 }, () => instance.list().map((sticker) => sticker.id).join(",")));
  assert.ok(orders.size > 1);
});
