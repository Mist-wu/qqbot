import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "500";
process.env.BOT_PRIVATE_USERS = "42";
process.env.BOT_ADMIN_USERS = "42";
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GATE_GROUP_DEBOUNCE_MS = "20";
process.env.GATE_DIRECT_DEBOUNCE_MS = "20";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
process.env.LOG_LEVEL = "silent";
process.env.MEMORY_LEARN_DELAY_MS = "15";
process.env.REPLY_FORWARD_PARTS = "0";
process.env.REPLY_FORWARD_CHARS = "0";

const { config } = await import("../src/config.js");
const { ChatRuntime } = await import("../src/chat/runtime.js");
const { MemoryStore } = await import("../src/chat/memory.js");
const { PowerSwitch } = await import("../src/chat/power.js");
const { StickerStore } = await import("../src/chat/stickers.js");
const { NapcatClient } = await import("../src/napcat/client.js");

const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
let nextId = 1;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 1500) throw new Error("timed out");
    await wait(5);
  }
};

function group(text: string, extra: Record<string, unknown>[] = []) {
  return {
    post_type: "message" as const,
    message_type: "group" as const,
    message_id: nextId++,
    user_id: 7,
    group_id: 500,
    self_id: 100,
    time: Math.floor(Date.now() / 1000),
    message: extra.length > 0 ? extra : [{ type: "text", data: { text } }],
    sender: { user_id: 7, nickname: "张三" },
  };
}

function command(text: string) {
  return {
    post_type: "message" as const,
    message_type: "private" as const,
    message_id: nextId++,
    user_id: 42,
    self_id: 100,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text } }],
    sender: { user_id: 42, nickname: "管理员" },
  };
}

test("stopping during the send gap drops the group message and still delivers the admin receipt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousInterval = config.napcat.sendIntervalMs;
  const previousDebounce = config.gate.groupDebounceMs;
  config.napcat.sendIntervalMs = 0;
  config.gate.groupDebounceMs = 1000;
  const client = new NapcatClient(() => undefined);
  client.selfId = 100;
  const actions: string[] = [];
  client.callAction = (async (action: string) => {
    actions.push(action);
    return { status: "ok" as const, retcode: 0, data: { message_id: nextId++, group_name: "测试群" } };
  }) as NapcatClient["callAction"];
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-stop-")), "state.json");
  const power = new PowerSwitch(file);
  await power.load();
  let releaseJudge!: () => void;
  let entered!: () => void;
  const judging = new Promise<void>((resolve) => {
    entered = resolve;
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "不该发出" } }] }), { status: 200 })) as typeof fetch;
  const runtime = new ChatRuntime({
    client,
    power,
    judge: async () => {
      entered();
      await new Promise<void>((resolve) => {
        releaseJudge = resolve;
      });
      return { should_reply: 0.9 };
    },
  });
  const drain = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  try {
    await client.sendMessage({ userId: 1 }, [{ type: "text", data: { text: "prime" } }]);
    config.napcat.sendIntervalMs = 30_000;
    runtime.handle(group("在吗"));
    t.mock.timers.tick(1000);
    await judging;
    releaseJudge();
    await drain();
    assert.equal(actions.includes("send_group_msg"), false);
    assert.equal(actions.includes("send_group_forward_msg"), false);
    runtime.handle(command("/停止"));
    for (let i = 0; i < 20 && power.on; i++) await drain();
    assert.equal(power.on, false);
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(30_000);
      await drain();
    }
    assert.equal(actions.includes("send_group_msg"), false);
    assert.equal(actions.includes("send_group_forward_msg"), false);
    assert.ok(actions.filter((action) => action === "send_private_msg").length >= 2);
  } finally {
    config.napcat.sendIntervalMs = previousInterval;
    config.gate.groupDebounceMs = previousDebounce;
    t.mock.timers.reset();
  }
});

test("a failed forward does not fall back to OneBot after stop", async () => {
  const actions: string[] = [];
  const client = new NapcatClient(() => undefined);
  client.selfId = 100;
  client.callAction = (async (action: string) => {
    actions.push(action);
    if (action === "send_group_forward_msg") throw new Error("forward unsupported");
    return { status: "ok" as const, retcode: 0, data: { message_id: nextId++ } };
  }) as NapcatClient["callAction"];
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-stop-")), "state.json");
  const power = new PowerSwitch(file);
  await power.load();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "这条会走合并转发" } }] }), { status: 200 })) as typeof fetch;
  const runtime = new ChatRuntime({ client, power, judge: async () => ({ should_reply: 0.9 }) });
  runtime.handle(group("在吗"));
  await until(() => actions.includes("send_group_forward_msg"));
  runtime.handle(command("/停止"));
  await until(() => actions.includes("send_private_msg"));
  await wait(900);
  assert.equal(actions.includes("send_group_msg"), false);
  assert.equal(power.on, false);
});

test("a sticker still being described is not saved after stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-stop-stickers-"));
  let releaseDescribe!: () => void;
  let described!: () => void;
  const describing = new Promise<void>((resolve) => {
    described = resolve;
  });
  let phase: "old" | "new" = "old";
  const stickers = new StickerStore(
    dir,
    async () => {
      if (phase === "old") {
        described();
        await new Promise<void>((resolve) => {
          releaseDescribe = resolve;
        });
        return "不该收藏";
      }
      return "新的";
    },
    10,
  );
  await stickers.load();
  globalThis.fetch = (async () => new Response(GIF, { status: 200 })) as typeof fetch;
  const sent: string[] = [];
  const client = {
    selfId: 100,
    sendMessage: async (_target: unknown, message: { data: { text?: string } }[]) => {
      sent.push(message[0]?.data.text ?? "");
      return nextId++;
    },
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: {} }),
  };
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-stop-")), "state.json");
  const power = new PowerSwitch(file);
  await power.load();
  const runtime = new ChatRuntime({
    client: client as never,
    power,
    stickers,
    judge: async () => ({ should_reply: 0 }),
  });
  runtime.handle(group("", [{ type: "image", data: { file: "old.gif", url: "https://img.example/old.gif", sub_type: 1 } }]));
  await describing;
  runtime.handle(command("/停止"));
  await until(() => sent.some((text) => text.includes("已停止")));
  releaseDescribe();
  await wait(30);
  assert.equal(stickers.size, 0);
  await stickers.flush();
  assert.equal((await readdir(dir)).some((name) => name.endsWith(".gif")), false);

  phase = "new";
  runtime.handle(command("/启动"));
  await until(() => sent.some((text) => text.includes("已启动")));
  runtime.handle(group("", [{ type: "image", data: { file: "new.gif", url: "https://img.example/new.gif", sub_type: 1 } }]));
  await until(() => stickers.size === 1);
  assert.equal(stickers.list()[0]!.description, "新的");
});

test("memory extraction in flight is dropped on stop and a later learn can still save", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-stop-memory-")), "memory.json");
  let releaseExtract!: () => void;
  let entered!: () => void;
  const extracting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let phase: "old" | "new" = "old";
  const memory = new MemoryStore(file, async () => {
    if (phase === "old") {
      entered();
      await new Promise<void>((resolve) => {
        releaseExtract = resolve;
      });
      return { people: [{ user_id: 7, facts: ["不该记住"] }] };
    }
    return { people: [{ user_id: 7, facts: ["可以记住"] }] };
  });
  const sent: string[] = [];
  const client = {
    selfId: 100,
    sendMessage: async (_target: unknown, message: { data: { text?: string } }[]) => {
      sent.push(message[0]?.data.text ?? "");
      return nextId++;
    },
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: {} }),
  };
  const state = join(await mkdtemp(join(tmpdir(), "qqbot-stop-")), "state.json");
  const power = new PowerSwitch(state);
  await power.load();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "好" } }] }), { status: 200 })) as typeof fetch;
  const runtime = new ChatRuntime({
    client: client as never,
    power,
    memory,
    judge: async () => ({ should_reply: 0.9 }),
  });
  runtime.handle(group("记住我"));
  await extracting;
  runtime.handle(command("/停止"));
  await until(() => sent.some((text) => text.includes("已停止")));
  releaseExtract();
  await wait(30);
  assert.equal(memory.get(7), undefined);

  phase = "new";
  await memory.learn("group", "测试群", [
    {
      userId: 7,
      name: "张三",
      text: "我会写代码",
      time: Date.now(),
      fromBot: false,
      atBot: false,
      replyToBot: false,
      mentionsBot: false,
    },
  ], "小猫");
  await memory.flush();
  const reloaded = new MemoryStore(file, async () => ({}));
  await reloaded.load();
  assert.deepEqual(reloaded.get(7)!.group, ["可以记住"]);
});
