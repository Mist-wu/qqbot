import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LOG_LEVEL = "silent";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";

const { config } = await import("../src/config.js");
const { NapcatClient } = await import("../src/napcat/client.js");
const { textSegment } = await import("../src/napcat/message.js");

const text = (value: string) => [textSegment(value)];

test("a send already handed to OneBot finishes, and the queued one checks liveness", async () => {
  const previous = config.napcat.sendIntervalMs;
  config.napcat.sendIntervalMs = 0;
  const client = new NapcatClient(() => undefined);
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  client.callAction = (async () => {
    calls++;
    if (calls === 1) {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return { status: "ok" as const, retcode: 0, data: { message_id: calls } };
  }) as NapcatClient["callAction"];
  try {
    let alive = true;
    const first = client.sendMessage({ groupId: 500 }, text("已经交给 OneBot"), () => alive);
    await inside;
    const second = client.sendMessage({ groupId: 500 }, text("还在队列里"), () => alive);
    alive = false;
    release();
    assert.equal(await first, 1);
    assert.equal(await second, undefined);
    assert.equal(calls, 1);
  } finally {
    config.napcat.sendIntervalMs = previous;
  }
});

test("the rate-limit wait checks liveness before calling OneBot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = config.napcat.sendIntervalMs;
  config.napcat.sendIntervalMs = 0;
  const client = new NapcatClient(() => undefined);
  let calls = 0;
  client.callAction = (async () => {
    calls++;
    return { status: "ok" as const, retcode: 0, data: { message_id: calls } };
  }) as NapcatClient["callAction"];
  try {
    await client.sendMessage({ groupId: 500 }, text("先手"));
    config.napcat.sendIntervalMs = 30_000;
    let alive = true;
    const second = client.sendMessage({ groupId: 500 }, text("等间隔"), () => alive);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(calls, 1);
    alive = false;
    t.mock.timers.tick(30_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(await second, undefined);
    assert.equal(calls, 1);
  } finally {
    config.napcat.sendIntervalMs = previous;
    t.mock.timers.reset();
  }
});
