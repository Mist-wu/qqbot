import { TypeSafeClient, noul, type EntryType, type JsonValue, type Questions } from "@typesafe-ai/sdk";

import { config } from "../config.js";
import { relation, type ChatRecord, type Presence, type Scope } from "./history.js";

export type GateContext = {
  scope: Scope;
  sessionLabel: string;
  botName: string;
  aliases: string[];
  persona: string;
  earlier: ChatRecord[];
  pending: ChatRecord[];
  presence: Presence;
  now: number;
};

export type GateScores = {
  reply: number;
  addressed: number;
  search: number;
  threshold: number;
};

export type GateDecision = {
  reply: boolean;
  // Whether to offer web_search to the model; the model still decides whether to call it.
  search: boolean;
  reason: string;
  source: "rule" | "jev" | "fallback";
  scores?: GateScores;
};

// Answers are yes-probabilities keyed by question name.
export type Judge = (state: EntryType, questions: Questions) => Promise<Record<string, number>>;

export function createJevJudge(): Judge {
  const client = new TypeSafeClient({
    apiKey: config.jev.apiKey,
    defaultModel: config.jev.model,
    timeout: config.jev.timeoutMs,
    retry: { maxRetries: 1 },
  });
  return async (state, questions) => {
    const result = await client.systemOne({ state, questions });
    const probabilities: Record<string, number> = {};
    for (const [name, answer] of Object.entries(result.answers)) {
      if (answer.type === "noul") probabilities[name] = answer.noul;
    }
    return probabilities;
  };
}

function relativeTime(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function describe(record: ChatRecord, ctx: GateContext): JsonValue {
  const entry: Record<string, JsonValue> = {
    from: record.fromBot ? `${ctx.botName} (the bot itself)` : record.name,
    text: record.text,
    when: relativeTime(record.time, ctx.now),
  };
  const { to, quote } = relation(record, ctx.botName);
  if (to.length > 0) entry.to = to;
  if (quote) entry.quoting = quote;
  if (record.atBot) entry.at_bot = true;
  if (record.replyToBot) entry.replies_to_bot = true;
  if (record.mentionsBot) entry.mentions_bot_name = true;
  return entry;
}

export function buildState(ctx: GateContext): EntryType {
  const sinceBot = ctx.presence.lastBotAt === undefined ? null : Math.round((ctx.now - ctx.presence.lastBotAt) / 1000);
  return {
    chat: ctx.scope === "group" ? `QQ group "${ctx.sessionLabel}"` : `QQ private chat with ${ctx.sessionLabel}`,
    bot: { name: ctx.botName, aliases: ctx.aliases, persona: ctx.persona },
    bot_activity: {
      bot_messages_last_5min: ctx.presence.bot,
      all_messages_last_5min: ctx.presence.total,
      seconds_since_bot_last_spoke: sinceBot,
    },
    earlier_messages: ctx.earlier.map((record) => describe(record, ctx)),
    new_messages: ctx.pending.map((record) => describe(record, ctx)),
  };
}

export function buildQuestions(botName: string): Questions {
  return {
    should_reply: noul(`Should ${botName}, a member of this QQ chat, send a message now in response to new_messages?`, {
      true: `new_messages call for a response from ${botName}, or ${botName} has something worth adding. Being @mentioned or replied to (at_bot, replies_to_bot) makes this more likely.`,
      false: `new_messages do not need anything from ${botName}: the exchange is between others, it is winding down, or a message from ${botName} would add nothing.`,
    }),
    addressed: noul(`new_messages are directed at ${botName} and expect it to respond.`),
    needs_search: noul(`A good reply to new_messages depends on up-to-date or specific facts that should be looked up on the web.`),
  };
}

// Only used when jev is unavailable: closing words and bare reactions that need no answer.
const BARE_REACTION =
  /^(?:[哈嘿呵嘻hH]+|草+|6+|[嗯恩哦噢喔啊]+|好+的?|好吧|行|ok|收到|懂了|明白了?|谢谢|谢了|多谢|感谢|thx|thanks|拜拜|晚安|[?？!！]+|\[[^\]]+\])+$/i;

export function isBareReaction(text: string): boolean {
  const core = text.replace(/@\S+/g, "").replace(/[\s,，.。~～…、]+/g, "");
  return core === "" || BARE_REACTION.test(core);
}

export async function decide(ctx: GateContext, judge: Judge | undefined): Promise<GateDecision> {
  // @ and replies only lower the bar; jev still decides, using the bot's recent activity in the state.
  const direct = ctx.pending.some((record) => record.atBot || record.replyToBot);
  const mentioned = ctx.pending.some((record) => record.mentionsBot);

  if (judge) {
    try {
      const answers = await judge(buildState(ctx), buildQuestions(ctx.botName));
      const reply = answers.should_reply ?? 0;
      const addressed = answers.addressed ?? 0;
      const search = answers.needs_search ?? 0;
      const threshold = direct
        ? config.gate.directThreshold
        : ctx.scope === "group"
          ? config.gate.groupThreshold
          : config.gate.privateThreshold;
      const yes = reply >= threshold;
      return {
        reply: yes,
        search: search > config.gate.searchThreshold,
        reason: `${direct ? "direct, " : ""}jev ${yes ? "yes" : "no"}`,
        source: "jev",
        scores: { reply, addressed, search, threshold },
      };
    } catch (error) {
      return fallback(ctx, direct, mentioned, `jev error: ${(error as Error).message}`);
    }
  }
  return fallback(ctx, direct, mentioned, "no jev");
}

// Without jev only clear signals trigger a reply; search is left to the model.
function fallback(ctx: GateContext, direct: boolean, mentioned: boolean, why: string): GateDecision {
  const signal = direct || mentioned || ctx.scope === "private";
  const reply = signal && !ctx.pending.every((record) => isBareReaction(record.text));
  return { reply, search: true, reason: why, source: "fallback" };
}
