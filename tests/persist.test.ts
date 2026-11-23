import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.LOG_LEVEL = "silent";

const { files } = await import("../src/persist.js");
const { MemoryStore } = await import("../src/chat/memory.js");
const { StickerStore } = await import("../src/chat/stickers.js");

const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
globalThis.fetch = (async () => new Response(GIF, { status: 200 })) as typeof fetch;
const stickerImage = (file: string) => ({ type: "image", data: { file, url: `https://img.example/${file}`, sub_type: 1 } });

function record(text: string) {
  return {
    userId: 7,
    name: "张三",
    text,
    time: Date.UTC(2026, 0, 2, 3, 4),
    fromBot: false,
    atBot: false,
    replyToBot: false,
    mentionsBot: false,
  };
}

async function hangFirstRename(suffix: string) {
  const original = files.rename;
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hangs = 0;
  files.rename = (async (from: string, to: string) => {
    if (String(to).endsWith(suffix) && hangs++ === 0) {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return original(from, to);
  }) as typeof files.rename;
  return {
    paused,
    release: () => release(),
    restore: () => {
      files.rename = original;
    },
  };
}

test("an older memory snapshot cannot overwrite a newer flush", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-persist-")), "memory.json");
  let phase = 0;
  const memory = new MemoryStore(file, async () => {
    phase++;
    return { people: [{ user_id: 7, facts: [phase === 1 ? "old" : "new"] }] };
  });
  await memory.learn("group", "群", [record("第一句")], "小猫");
  const gate = await hangFirstRename("memory.json");
  try {
    const first = memory.flush();
    await gate.paused;
    await memory.learn("group", "群", [record("第二句")], "小猫");
    const second = memory.flush();
    gate.release();
    await first;
    await second;
  } finally {
    gate.restore();
  }
  const reloaded = new MemoryStore(file, async () => ({}));
  await reloaded.load();
  assert.deepEqual(reloaded.get(7)!.group, ["new"]);
  assert.deepEqual(memory.get(7)!.group, ["new"]);
});

test("a failed memory write is visible and the next flush still saves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-persist-"));
  const file = join(dir, "memory.json");
  const memory = new MemoryStore(file, async () => ({ people: [{ user_id: 7, facts: ["留下"] }] }));
  await memory.learn("group", "群", [record("记下")], "小猫");
  const original = files.rename;
  files.rename = (async () => {
    throw new Error("disk full");
  }) as typeof files.rename;
  try {
    await assert.rejects(memory.flush(), /disk full/);
  } finally {
    files.rename = original;
  }
  assert.equal((await readdir(dir)).some((name) => name.endsWith(".tmp")), false);
  await memory.flush();
  const reloaded = new MemoryStore(file, async () => ({}));
  await reloaded.load();
  assert.deepEqual(reloaded.get(7)!.group, ["留下"]);
});

test("an older sticker index cannot overwrite a newer flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-stickers-"));
  const store = new StickerStore(dir, async () => "猫猫叹气", 10);
  await store.load();
  await store.observe(stickerImage("a.gif"));
  assert.equal(store.byId(1)!.seen, 1);
  const gate = await hangFirstRename("index.json");
  try {
    const first = store.flush();
    await gate.paused;
    await store.observe(stickerImage("a.gif"));
    assert.equal(store.byId(1)!.seen, 2);
    const second = store.flush();
    gate.release();
    await first;
    await second;
  } finally {
    gate.restore();
  }
  const saved = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as { seen: number }[];
  assert.equal(saved[0]!.seen, 2);
  const reloaded = new StickerStore(dir, async () => "不该调用");
  await reloaded.load();
  assert.equal(reloaded.byId(1)!.seen, 2);
});
