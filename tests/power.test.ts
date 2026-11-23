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
const { files } = await import("../src/persist.js");
type Deps = ConstructorParameters<typeof ChatRuntime>[0];

let nextId = 1;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 1000) throw new Error("timed out");
    await wait(5);
  }
};
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
  const runtime = new ChatRuntime({ client, judge, stickers: undefined, memory: undefined, power });

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

test("/停止 mid-flight cancels an in-progress reply, including after /启动", async () => {
  let releaseReply!: () => void;
  let entered!: () => void;
  const generating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  globalThis.fetch = (async () => {
    entered();
    await new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: "不该发出" } }] }), { status: 200 });
  }) as typeof fetch;
  const sent: { target: unknown; text: unknown }[] = [];
  const client = {
    selfId: 100,
    sendMessage: async (target: unknown, message: { data: { text?: string } }[]) => {
      sent.push({ target, text: message[0]!.data.text });
      return nextId++;
    },
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: {} }),
  } as unknown as Deps["client"];
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-power-")), "state.json");
  const power = new PowerSwitch(file);
  await power.load();
  const runtime = new ChatRuntime({ client, power, judge: async () => ({ should_reply: 0.9 }) });

  runtime.handle(message("group", 7, "在吗"));
  await generating;
  runtime.handle(message("private", 42, "/停止"));
  await until(() => sent.some((item) => item.text === "小猫 已停止，群聊和私聊都不再回复，发 /启动 恢复"));
  runtime.handle(message("private", 42, "/启动"));
  await until(() => sent.some((item) => item.text === "小猫 已启动"));
  assert.equal(power.on, true);
  releaseReply();
  await wait(50);
  assert.deepEqual(
    sent.filter((item) => (item.target as { groupId?: number }).groupId === 500),
    [],
  );
});

async function harness() {
  const sent: { target: unknown; text: unknown }[] = [];
  const client = {
    selfId: 100,
    sendMessage: async (target: unknown, message: { data: { text?: string } }[]) => {
      sent.push({ target, text: message[0]?.data.text });
      return nextId++;
    },
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: {} }),
  } as unknown as Deps["client"];
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-power-")), "state.json");
  const power = new PowerSwitch(file);
  await power.load();
  const runtime = new ChatRuntime({ client, power, judge: async () => ({ should_reply: 0 }) });
  return { sent, file, power, runtime };
}

function textsOf(sent: { text: unknown }[]) {
  return sent.map((item) => item.text);
}

test("stop then start runs in receive order while the first write is paused", async () => {
  const { sent, file, power, runtime } = await harness();
  const original = files.rename;
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hangs = 0;
  files.rename = (async (from: string, to: string) => {
    if (String(to).endsWith("state.json") && hangs++ === 0) {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return original(from, to);
  }) as typeof files.rename;
  try {
    runtime.handle(message("private", 42, "/停止"));
    await paused;
    runtime.handle(message("private", 42, "/启动"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual(textsOf(sent), []);
    assert.equal(power.on, true);
    release();
    await until(() => sent.length >= 2);
    assert.deepEqual(textsOf(sent), [
      "小猫 已停止，群聊和私聊都不再回复，发 /启动 恢复",
      "小猫 已启动",
    ]);
    assert.equal(power.on, true);
    const reloaded = new PowerSwitch(file);
    await reloaded.load();
    assert.equal(reloaded.on, true);
  } finally {
    files.rename = original;
  }
});

test("start then stop runs in receive order while the first write is paused", async () => {
  const { sent, file, power, runtime } = await harness();
  await power.set(false);
  const original = files.rename;
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hangs = 0;
  files.rename = (async (from: string, to: string) => {
    if (String(to).endsWith("state.json") && hangs++ === 0) {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return original(from, to);
  }) as typeof files.rename;
  try {
    runtime.handle(message("private", 42, "/启动"));
    await paused;
    runtime.handle(message("private", 42, "/停止"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual(textsOf(sent), []);
    assert.equal(power.on, false);
    release();
    await until(() => sent.length >= 2);
    assert.deepEqual(textsOf(sent), ["小猫 已启动", "小猫 已停止，群聊和私聊都不再回复，发 /启动 恢复"]);
    assert.equal(power.on, false);
    const reloaded = new PowerSwitch(file);
    await reloaded.load();
    assert.equal(reloaded.on, false);
  } finally {
    files.rename = original;
  }
});

test("a failed switch write keeps the old state and the next command still runs", async () => {
  const { sent, file, power, runtime } = await harness();
  const original = files.rename;
  let fails = 0;
  files.rename = (async (from: string, to: string) => {
    if (String(to).endsWith("state.json") && fails++ === 0) throw new Error("readonly");
    return original(from, to);
  }) as typeof files.rename;
  try {
    runtime.handle(message("private", 42, "/停止"));
    runtime.handle(message("private", 42, "/启动"));
    await until(() => sent.length >= 2);
    assert.equal(power.on, true);
    assert.deepEqual(textsOf(sent), ["保存开关状态失败，请检查日志", "小猫 已经在运行"]);
    const reloaded = new PowerSwitch(file);
    await reloaded.load();
    assert.equal(reloaded.on, true);
  } finally {
    files.rename = original;
  }
});
