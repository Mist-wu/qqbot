import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "500";
process.env.BOT_PRIVATE_USERS = "";
process.env.BOT_ADMIN_USERS = "42";
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GATE_GROUP_DEBOUNCE_MS = "10";
process.env.GATE_DIRECT_DEBOUNCE_MS = "10";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
process.env.LOG_LEVEL = "silent";

const { ChatRuntime } = await import("../src/chat/runtime.js");
const { PowerSwitch } = await import("../src/chat/power.js");
type Deps = ConstructorParameters<typeof ChatRuntime>[0];

let nextId = 1;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (type: "group" | "private", userId: number, text: string) => ({
  post_type: "message" as const,
  message_type: type,
  message_id: nextId++,
  user_id: userId,
  group_id: type === "group" ? 500 : undefined,
  self_id: 100,
  time: Math.floor(Date.now() / 1000),
  message: [{ type: "text", data: { text } }],
  sender: { user_id: userId, nickname: "张三" },
});

test("admin /停止 and /启动 in private chat pause and resume the bot, across restarts", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "在" } }] }), { status: 200 })) as typeof fetch;
  const sent: { target: unknown; text: unknown }[] = [];
  let judged = 0;
  const client = {
    selfId: 100,
    sendMessage: async (target: unknown, message: { data: { text?: string } }[]) => {
      sent.push({ target, text: message[0]!.data.text });
      return nextId++;
    },
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: {} }),
  } as unknown as Deps["client"];
  const judge = async () => {
    judged++;
    return { should_reply: 0.9 };
  };
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-power-")), "state.json");
  const power = new PowerSwitch(file);
  await power.load();
  const runtime = new ChatRuntime({ client, judge, search: undefined, stickers: undefined, memory: undefined, power });

  runtime.handle(message("private", 42, "/停止"));
  await wait(50);
  assert.equal(power.on, false);
  assert.deepEqual(sent.at(-1), { target: { userId: 42 }, text: "小猫 已停止，群聊和私聊都不再回复，发 /启动 恢复" });

  runtime.handle(message("group", 7, "有人吗"));
  runtime.handle(message("private", 42, "在吗"));
  await wait(100);
  assert.equal(judged, 0);

  runtime.handle(message("private", 42, "/停止"));
  await wait(50);
  assert.equal(sent.at(-1)!.text, "小猫 已经是停止状态");

  const reloaded = new PowerSwitch(file);
  await reloaded.load();
  assert.equal(reloaded.on, false);

  runtime.handle(message("private", 7, "/启动"));
  runtime.handle(message("private", 42, "toString"));
  await wait(50);
  assert.equal(power.on, false);

  runtime.handle(message("private", 42, "/启动"));
  await wait(50);
  assert.equal(power.on, true);
  assert.equal(sent.at(-1)!.text, "小猫 已启动");

  runtime.handle(message("group", 7, "有人吗"));
  await wait(100);
  assert.equal(judged, 1);
});
