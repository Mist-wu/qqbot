export type Scope = "group" | "private";

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
  // Other users @-mentioned in this message.
  mentions?: number[];
  // Resolves once sticker descriptions and @ names have been filled into text.
  ready?: Promise<void>;
};

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
