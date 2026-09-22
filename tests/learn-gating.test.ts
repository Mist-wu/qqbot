import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "500,600";
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GATE_GROUP_DEBOUNCE_MS = "10";
process.env.GATE_DIRECT_DEBOUNCE_MS = "10";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
process.env.MEMORY_LEARN_BATCH = "3";
process.env.MEMORY_LEARN_DELAY_MS = "100000";
process.env.LOG_LEVEL = "silent";

const { ChatRuntime } = await import("../src/chat/runtime.js");
const { MemoryStore } = await import("../src/chat/memory.js");
type Deps = ConstructorParameters<typeof ChatRuntime>[0];

let nextId = 1;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (groupId: number, text: string, extra: Record<string, unknown>[] = []) => ({
  post_type: "message" as const,
  message_type: "group" as const,
  message_id: nextId++,
  user_id: 7,
  group_id: groupId,
  self_id: 100,
  time: Math.floor(Date.now() / 1000),
  message: [...extra, { type: "text", data: { text } }] as { type: string; data: Record<string, unknown> }[],
  sender: { user_id: 7, nickname: "张三" },
});

test("batch learning only happens where the bot recently took part", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "嗯" } }] }), { status: 200 })) as typeof fetch;
  const learned: string[] = [];
  const memory = new MemoryStore(join(tmpdir(), `qqbot-gate-${process.pid}.json`), async (_system, user) => {
    learned.push(user.split("\n")[0]!);
    return { people: [] };
  });
  const client = {
    selfId: 100,
    sendMessage: async () => nextId++,
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: {} }),
  } as unknown as Deps["client"];
  const judge = async (state: unknown) => {
    const text = (state as { new_messages: { text: string }[] }).new_messages[0]!.text;
    return { should_reply: text.includes("@小猫") ? 0.9 : 0 };
  };
  const runtime = new ChatRuntime({ client, judge, search: undefined, stickers: undefined, memory });

  for (let i = 0; i < 4; i++) {
    runtime.handle(message(600, `闲聊${i}`));
    await wait(30);
  }
  await wait(50);
  assert.deepEqual(learned, []);

  runtime.handle(message(500, "在吗", [{ type: "at", data: { qq: "100" } }]));
  await wait(100);
  for (let i = 0; i < 3; i++) {
    runtime.handle(message(500, `继续${i}`));
    await wait(30);
  }
  await wait(50);
  assert.equal(learned.length, 1);
  assert.match(learned[0]!, /500/);
});
