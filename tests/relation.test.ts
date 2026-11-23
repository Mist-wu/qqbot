import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.LOG_LEVEL = "silent";
process.env.BOT_NAME = "小猫";

const { buildState } = await import("../src/chat/gate.js");
const { buildTranscript } = await import("../src/chat/reply.js");
const { MemoryStore } = await import("../src/chat/memory.js");
const { formatLine } = await import("../src/chat/history.js");

const now = Date.UTC(2026, 0, 2, 4, 5);

test("replying to the bot while @-ing someone else names the same recipients in all three prompts", async () => {
  const record = {
    messageId: 2,
    userId: 7,
    name: "张三",
    text: "@小猫 @李四 看看",
    time: now,
    fromBot: false,
    atBot: true,
    replyToBot: true,
    mentions: new Map([[9, "李四"]]),
    quote: { name: "小猫", text: "刚才那句", fromBot: true },
  };
  const state = buildState({
    scope: "group",
    sessionLabel: "测试群",
    botName: "小猫",
    aliases: [],
    persona: "群友",
    earlier: [],
    pending: [record],
    presence: { bot: 0, total: 1 },
    now,
  }) as { new_messages: { to?: string[]; quoting?: string }[] };
  assert.deepEqual(state.new_messages[0]!.to, ["小猫", "李四"]);
  assert.equal(state.new_messages[0]!.quoting, "小猫的「刚才那句」");

  const transcript = buildTranscript({
    scope: "group",
    sessionLabel: "测试群",
    botName: "小猫",
    persona: "群友",
    earlier: [],
    pending: [record],
    stickers: [],
    memories: [],
    now,
    search: false,
    readLinks: false,
    voice: false,
  });
  assert.match(transcript, /★/);
  assert.match(transcript, /张三 → 你、李四：@小猫 @李四 看看（引用你的「刚才那句」）/);
  assert.equal(formatLine(record, "张三（QQ 7）", "小猫"), "张三（QQ 7） → 小猫、李四：@小猫 @李四 看看（引用小猫的「刚才那句」）");

  const prompts: string[] = [];
  const memory = new MemoryStore(join(await mkdtemp(join(tmpdir(), "qqbot-relation-")), "memory.json"), async (_system, user) => {
    prompts.push(user);
    return { people: [] };
  });
  await memory.learn("group", "测试群", [record], "小猫");
  assert.match(prompts[0]!, /张三（QQ 7） → 小猫、李四：@小猫 @李四 看看（引用小猫的「刚才那句」）/);
});
