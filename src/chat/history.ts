export type Scope = "group" | "private";

export type Quote = { name: string; text: string; fromBot: boolean };

export type ChatRecord = {
  messageId?: number;
  userId: number;
  name: string;
  text: string;
  time: number;
  fromBot: boolean;
  atBot: boolean;
  replyToBot: boolean;
  mentionsBot: boolean;
  // Other users @-mentioned in this message, and their display names once resolved.
  mentions?: number[];
  mentionNames?: string[];
  // The message this one replies to.
  quote?: Quote;
  // Resolves once sticker descriptions, @ names and the quote have been filled in.
  ready?: Promise<void>;
};

const QUOTE_MAX_CHARS = 60;

// Who a message is aimed at, and what it quotes, so a reader can follow who is talking to whom.
// `self` is how the bot is referred to (e.g. "你" in its own prompt).
export function relation(record: ChatRecord, self: string): { to: string[]; quote?: string } {
  const to = [...(record.atBot ? [self] : []), ...(record.mentionNames ?? [])];
  const quoted = record.quote;
  if (to.length === 0 && quoted) to.push(quoted.fromBot ? self : quoted.name);
  if (!quoted) return { to };
  const text = quoted.text.replace(/\s+/g, " ");
  const short = text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS)}…` : text;
  return { to, quote: `${quoted.fromBot ? self : quoted.name}的「${short}」` };
}

// "名字 → 对象：正文（引用 某人的「原文」）"
export function formatLine(record: ChatRecord, speaker: string, self: string): string {
  const { to, quote } = relation(record, self);
  const arrow = to.length > 0 ? ` → ${to.join("、")}` : "";
  return `${speaker}${arrow}：${record.text}${quote ? `（引用${quote}）` : ""}`;
}

export type Presence = {
  bot: number;
  total: number;
  lastBotAt?: number;
};

const MAX_BOT_MESSAGE_IDS = 500;

export class SessionHistory {
  private readonly records: ChatRecord[] = [];
  private readonly botMessageIds = new Set<number>();
  // Number of records ever added; a mark into this count survives trimming.
  total = 0;

  constructor(private readonly maxRecords: number) {}

  add(record: ChatRecord): void {
    this.total++;
    this.records.push(record);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    if (record.fromBot && record.messageId !== undefined) {
      this.botMessageIds.add(record.messageId);
      if (this.botMessageIds.size > MAX_BOT_MESSAGE_IDS) {
        this.botMessageIds.delete(this.botMessageIds.values().next().value!);
      }
    }
  }

  isBotMessage(messageId: number): boolean {
    return this.botMessageIds.has(messageId);
  }

  recent(count: number): ChatRecord[] {
    return this.records.slice(-count);
  }

  since(mark: number): ChatRecord[] {
    const count = Math.min(this.records.length, this.total - mark);
    return count > 0 ? this.records.slice(-count) : [];
  }

  byId(messageId: number): ChatRecord | undefined {
    return this.records.findLast((record) => record.messageId === messageId);
  }

  last(): ChatRecord | undefined {
    return this.records.at(-1);
  }

  presence(windowMs: number, now: number): Presence {
    let bot = 0;
    let total = 0;
    let lastBotAt: number | undefined;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i]!;
      if (record.fromBot && lastBotAt === undefined) lastBotAt = record.time;
      if (now - record.time > windowMs) continue;
      total++;
      if (record.fromBot) bot++;
    }
    return { bot, total, lastBotAt };
  }
}
