import assert from "node:assert/strict";
import { test } from "node:test";

process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "500";
process.env.BOT_PRIVATE_USERS = "";
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GATE_GROUP_DEBOUNCE_MS = "250";
process.env.GATE_PRIVATE_DEBOUNCE_MS = "250";
process.env.GATE_DIRECT_DEBOUNCE_MS = "40";
process.env.GATE_MAX_WAIT_MS = "120";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
process.env.LOG_LEVEL = "silent";

const { ChatRuntime } = await import("../src/chat/runtime.js");

let nextId = 1;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function message(text: string, extra: Record<string, unknown>[] = []) {
  return {
    post_type: "message" as const,
    message_type: "group" as const,
    message_id: nextId++,
    user_id: 7,
    group_id: 500,
    self_id: 100,
    time: Math.floor(Date.now() / 1000),
    message: [...extra, { type: "text", data: { text } }],
    sender: { user_id: 7, nickname: "张三" },
  };
}

function open(judge: () => Promise<void> | void) {
  const client = {
    selfId: 100,
    sendMessage: async () => nextId++,
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: {} }),
  };
  return new ChatRuntime({
    client: client as never,
    power: { on: true, set: async () => {} },
    judge: async () => {
      await judge();
      return { should_reply: 0 };
    },
  });
}

test("a busy session starts the next batch immediately once maxWait has passed", async () => {
  let release!: () => void;
  let markFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    markFirst = resolve;
  });
  let count = 0;
  let secondAt = 0;
  let releasedAt = 0;
  const second = new Promise<void>((resolve) => {
    const runtime = open(async () => {
      count++;
      if (count === 1) {
        markFirst();
        await new Promise<void>((done) => {
          release = done;
        });
        return;
      }
      secondAt = Date.now();
      resolve();
    });
    runtime.handle(message("第一批"));
    void first.then(() => {
      runtime.handle(message("第二批"));
    });
  });
  await first;
  await wait(180);
  releasedAt = Date.now();
  release();
  await second;
  assert.ok(secondAt - releasedAt < 70, `next batch waited ${secondAt - releasedAt}ms`);
});

test("ordinary and direct messages keep their own debounce", async () => {
  let ordinary = 0;
  let direct = 0;
  const ordinaryRuntime = open(() => {
    ordinary++;
  });
  const directRuntime = open(() => {
    direct++;
  });
  const started = Date.now();
  ordinaryRuntime.handle(message("普通一句"));
  directRuntime.handle(message("点名", [{ type: "at", data: { qq: "100" } }]));
  await wait(20);
  assert.equal(ordinary, 0);
  assert.equal(direct, 0);
  await wait(70);
  assert.equal(direct, 1);
  assert.equal(ordinary, 0);
  assert.ok(Date.now() - started < 200);
  await wait(250);
  assert.equal(ordinary, 1);
});

test("continuous messages are capped by maxWait", async () => {
  let judgedAt = 0;
  const runtime = open(() => {
    judgedAt = Date.now();
  });
  const started = Date.now();
  runtime.handle(message("连发一"));
  await wait(80);
  runtime.handle(message("连发二"));
  await wait(90);
  assert.ok(judgedAt > 0, "batch was not judged");
  const elapsed = judgedAt - started;
  assert.ok(elapsed < 200, `judged at ${elapsed}ms`);
  assert.ok(elapsed >= 100, `judged too early at ${elapsed}ms`);
});
