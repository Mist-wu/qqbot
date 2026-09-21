import assert from "node:assert/strict";
import { test } from "node:test";

process.env.GATE_GROUP_THRESHOLD = "0.6";
process.env.GATE_PRIVATE_THRESHOLD = "0.35";
process.env.GATE_DIRECT_THRESHOLD = "0.3";
process.env.GATE_SEARCH_THRESHOLD = "0.1";

const { decide, buildState, isBareReaction } = await import("../src/chat/gate.js");
type GateContext = Parameters<typeof decide>[0];
type ChatRecord = GateContext["pending"][number];

const now = 1_800_000_000_000;

function record(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    messageId: 1,
    userId: 2,
    name: "张三",
    text: "今天吃什么",
    time: now - 1000,
    fromBot: false,
    atBot: false,
    replyToBot: false,
    mentionsBot: false,
    ...overrides,
  };
}

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    scope: "group",
    sessionLabel: "测试群",
    botName: "小猫",
    aliases: [],
    persona: "普通网友",
    earlier: [],
    pending: [record()],
    presence: { bot: 0, total: 1 },
    now,
    ...overrides,
  };
}

const judge = (answers: Record<string, number>) => async () => answers;

test("jev score above threshold replies, below skips", async () => {
  const yes = await decide(context(), judge({ should_reply: 0.7, addressed: 0.2 }));
  assert.equal(yes.reply, true);
  assert.equal(yes.source, "jev");

  const no = await decide(context(), judge({ should_reply: 0.5, addressed: 0.2 }));
  assert.equal(no.reply, false);
});

test("@ or reply lowers the bar but jev can still decline", async () => {
  const pending = [record({ atBot: true, text: "@小猫 你怎么看" })];
  const yes = await decide(context({ pending }), judge({ should_reply: 0.4, addressed: 0.9 }));
  assert.equal(yes.reply, true);
  assert.equal(yes.scores!.threshold, 0.3);

  const closing = [record({ replyToBot: true, text: "哈哈哈" })];
  const no = await decide(context({ pending: closing }), judge({ should_reply: 0.1, addressed: 0.8 }));
  assert.equal(no.reply, false);
  assert.equal(no.source, "jev");
});

test("search tool is offered above a low needs_search score", async () => {
  const at = (needs_search: number) => judge({ should_reply: 0.8, addressed: 0.8, needs_search });
  assert.equal((await decide(context(), at(0.31))).search, true);
  assert.equal((await decide(context(), at(0.11))).search, true);
  assert.equal((await decide(context(), at(0.1))).search, false);
  assert.equal((await decide(context(), at(0.05))).search, false);
  assert.equal((await decide(context({ scope: "private" }), undefined)).search, true);
});

test("no hard cooldown: jev decides even right after the bot spoke", async () => {
  const presence = { bot: 3, total: 4, lastBotAt: now - 2000 };
  const decision = await decide(context({ presence }), judge({ should_reply: 0.8, addressed: 0.1 }));
  assert.equal(decision.reply, true);
  assert.equal(decision.scores!.threshold, 0.6);
});

test("bot activity is visible to jev", () => {
  const state = buildState(context({ presence: { bot: 2, total: 9, lastBotAt: now - 30_000 } })) as Record<string, any>;
  assert.deepEqual(state.bot_activity, {
    bot_messages_last_5min: 2,
    all_messages_last_5min: 9,
    seconds_since_bot_last_spoke: 30,
  });
});

test("falls back to hard rules when jev fails or is missing", async () => {
  const failing = async () => {
    throw new Error("boom");
  };
  assert.equal((await decide(context(), failing)).reply, false);
  assert.equal((await decide(context({ pending: [record({ mentionsBot: true })] }), failing)).reply, true);
  assert.equal((await decide(context({ scope: "private" }), undefined)).reply, true);
  assert.equal((await decide(context(), undefined)).source, "fallback");
  const at = (text: string) => context({ pending: [record({ atBot: true, text })] });
  assert.equal((await decide(at("@小猫 帮我看看这个报错"), undefined)).reply, true);
  assert.equal((await decide(at("@小猫 哈哈哈哈"), undefined)).reply, false);
  assert.equal((await decide(context({ scope: "private", pending: [record({ text: "好的谢谢" })] }), undefined)).reply, false);
});

test("bare reactions and closings are recognized", () => {
  for (const text of ["哈哈哈", "@小猫 草", "666", "好的！", "嗯嗯", "ok", "谢谢~", "[表情包]", "？？"]) {
    assert.equal(isBareReaction(text), true, text);
  }
  for (const text of ["哈哈哈这个好笑在哪", "好的，那明天几点", "6点见", "为什么"]) {
    assert.equal(isBareReaction(text), false, text);
  }
});

test("state marks the bot's own messages and flags", () => {
  const state = buildState(
    context({ earlier: [record({ fromBot: true, text: "我在" })], pending: [record({ atBot: true })] }),
  ) as Record<string, any>;
  assert.equal(state.earlier_messages[0].from, "小猫 (the bot itself)");
  assert.equal(state.new_messages[0].at_bot, true);
});
