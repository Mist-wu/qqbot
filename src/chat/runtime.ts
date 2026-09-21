import { config } from "../config.js";
import { logger } from "../logger.js";
import type { NapcatClient, SendTarget } from "../napcat/client.js";
import {
  atTargets,
  isAtSelf,
  isSticker,
  renderSegments,
  replySegment,
  replyTargetId,
  textToSegments,
  toSegments,
} from "../napcat/message.js";
import type { MessageEvent, Segment } from "../napcat/types.js";
import type { CodexWebSearch } from "../search/web-search.js";
import { decide, type GateDecision, type Judge } from "./gate.js";
import { SessionHistory, type ChatRecord, type Scope } from "./history.js";
import type { ImageDescriber } from "./images.js";
import type { MemoryStore } from "./memory.js";
import { generateReply, planSends, type ReplyPart } from "./reply.js";
import type { StickerStore } from "./stickers.js";

type Session = {
  key: string;
  scope: Scope;
  target: SendTarget;
  label: string;
  history: SessionHistory;
  pending: ChatRecord[];
  firstPendingAt: number | undefined;
  timer: NodeJS.Timeout | undefined;
  busy: boolean;
  learnedMark: number;
  learnTimer: NodeJS.Timeout | undefined;
};

export type RuntimeDeps = {
  client: Pick<NapcatClient, "selfId" | "sendMessage" | "sendForward" | "callAction">;
  judge: Judge | undefined;
  search: CodexWebSearch | undefined;
  stickers: StickerStore | undefined;
  images?: ImageDescriber | undefined;
  memory: MemoryStore | undefined;
};

const MEDIA_WAIT_MS = 8000;

export class ChatRuntime {
  private readonly sessions = new Map<string, Session>();
  // Group card or nickname by "groupId:userId", learned from senders and member lookups.
  private readonly memberNames = new Map<string, string>();

  constructor(private readonly deps: RuntimeDeps) {}

  handle(event: MessageEvent): void {
    const selfId = this.deps.client.selfId ?? event.self_id;
    if (event.user_id === selfId) return;
    const scope: Scope = event.message_type;
    if (scope === "group" && !config.bot.groups.has(event.group_id ?? 0)) return;
    if (scope === "private" && !config.bot.privateUsers.has(event.user_id)) return;

    const groupId = scope === "group" ? event.group_id : undefined;
    const senderName = event.sender?.card || event.sender?.nickname || String(event.user_id);
    if (groupId !== undefined) this.memberNames.set(`${groupId}:${event.user_id}`, senderName);

    const segments = toSegments(event.message);
    const atName = (userId: number) =>
      groupId === undefined ? undefined : this.memberNames.get(`${groupId}:${userId}`);
    const renderContext = { selfId, botName: config.bot.name, atName };
    const text = renderSegments(segments, renderContext);
    if (!text) return;

    const session = this.session(event);
    const replyTo = replyTargetId(segments);
    const names = [config.bot.name, ...config.bot.aliases];
    const mentions = atTargets(segments, selfId);
    const record: ChatRecord = {
      messageId: event.message_id,
      userId: event.user_id,
      name: senderName,
      text,
      time: event.time ? event.time * 1000 : Date.now(),
      fromBot: false,
      atBot: isAtSelf(segments, selfId),
      replyToBot: replyTo !== undefined && session.history.isBotMessage(replyTo),
      mentionsBot: names.some((name) => name && text.includes(name)),
      mentions,
    };

    const media = segments.filter((seg) => seg.type === "image" || seg.type === "mface");
    const unknownNames = groupId === undefined ? [] : mentions.filter((userId) => atName(userId) === undefined);
    if (media.length > 0 || unknownNames.length > 0) {
      record.ready = Promise.all([
        this.describeMedia(media),
        ...unknownNames.map((userId) => this.lookupMember(groupId!, userId)),
      ]).then(([descriptions]) => {
        record.text = renderSegments(segments, { ...renderContext, imageText: (seg) => descriptions.get(seg) });
      });
    }
    session.history.add(record);
    session.pending.push(record);
    this.schedule(session);
    if (session.history.total - session.learnedMark >= config.memory.learnBatch) this.scheduleLearn(session, 0);
  }

  private session(event: MessageEvent): Session {
    const scope: Scope = event.message_type;
    const key = scope === "group" ? `group:${event.group_id}` : `private:${event.user_id}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        key,
        scope,
        target: scope === "group" ? { groupId: event.group_id! } : { userId: event.user_id },
        label: scope === "group" ? String(event.group_id) : event.sender?.nickname || String(event.user_id),
        history: new SessionHistory(config.history.maxMessages),
        pending: [],
        firstPendingAt: undefined,
        timer: undefined,
        busy: false,
        learnedMark: 0,
        learnTimer: undefined,
      };
      this.sessions.set(key, session);
      if (scope === "group") void this.loadGroupName(session, event.group_id!);
    }
    return session;
  }

  private async lookupMember(groupId: number, userId: number): Promise<void> {
    try {
      const info = await this.deps.client.callAction<{ card?: string; nickname?: string }>("get_group_member_info", {
        group_id: groupId,
        user_id: userId,
      });
      const name = info.data?.card || info.data?.nickname;
      if (name) this.memberNames.set(`${groupId}:${userId}`, name);
    } catch (error) {
      logger.debug(`获取群成员失败 ${groupId}:${userId}:`, (error as Error).message);
    }
  }

  private async loadGroupName(session: Session, groupId: number): Promise<void> {
    try {
      const info = await this.deps.client.callAction<{ group_name?: string }>("get_group_info", { group_id: groupId });
      if (info.data?.group_name) session.label = info.data.group_name;
    } catch (error) {
      logger.debug(`获取群名失败 ${groupId}:`, (error as Error).message);
    }
  }

  private schedule(session: Session): void {
    if (session.busy || session.pending.length === 0) return;
    const now = Date.now();
    session.firstPendingAt ??= now;
    const direct = session.pending.some((record) => record.atBot || record.replyToBot);
    const debounce = direct
      ? config.gate.directDebounceMs
      : session.scope === "group"
        ? config.gate.groupDebounceMs
        : config.gate.privateDebounceMs;
    const delay = Math.max(0, Math.min(debounce, session.firstPendingAt + config.gate.maxWaitMs - now));
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => void this.process(session), delay);
  }

  private async process(session: Session): Promise<void> {
    session.timer = undefined;
    if (session.busy || session.pending.length === 0) return;
    session.busy = true;
    const pending = session.pending.splice(0);
    session.firstPendingAt = undefined;
    try {
      await Promise.race([Promise.all(pending.map((record) => record.ready)), sleep(MEDIA_WAIT_MS)]);
      const now = Date.now();
      const pendingSet = new Set(pending);
      const records = session.history.recent(config.history.contextMessages + pending.length);
      const decision = await decide(
        {
          scope: session.scope,
          sessionLabel: session.label,
          botName: config.bot.name,
          aliases: config.bot.aliases,
          persona: config.bot.persona,
          earlier: records.filter((record) => !pendingSet.has(record)),
          pending,
          presence: session.history.presence(config.gate.presenceWindowMs, now),
          now,
        },
        this.deps.judge,
      );
      logger.info(`[gate] ${session.key} ${formatDecision(decision)} :: ${summarize(pending)}`);
      if (decision.reply) await this.reply(session, records, pendingSet, decision.search);
    } catch (error) {
      logger.error(`[chat] ${session.key} 处理失败:`, (error as Error).message);
    } finally {
      session.busy = false;
      this.schedule(session);
    }
  }

  private async reply(
    session: Session,
    records: ChatRecord[],
    pending: Set<ChatRecord>,
    withSearch: boolean,
  ): Promise<void> {
    const search = withSearch && (await this.deps.search?.usable()) ? this.deps.search : undefined;
    const parts = await generateReply(
      {
        scope: session.scope,
        sessionLabel: session.label,
        botName: config.bot.name,
        persona: config.bot.persona,
        records,
        pending,
        stickers: this.deps.stickers?.list() ?? [],
        memories: this.deps.memory?.describe(records) ?? [],
        now: Date.now(),
      },
      search,
    );
    if (parts.length === 0) {
      logger.info(`[chat] ${session.key} 模型选择不回复`);
      return;
    }

    const list = [...pending];
    const target = list.findLast((record) => record.atBot || record.replyToBot) ?? list.at(-1)!;
    // Quote only when the conversation moved on while the reply was being written.
    const quote =
      session.scope === "group" && target.messageId !== undefined && session.history.last() !== target;

    const members = this.members(session);
    for (const [index, item] of planSends(parts).entries()) {
      if (index > 0) await sleep(item.kind === "forward" ? 1500 : typingDelay(item.part));
      if (item.kind === "forward") {
        await this.sendForward(session, item.text, members);
        continue;
      }
      const sent = await this.toSegments(item.part, members);
      if (!sent) continue;
      const segments = index === 0 && quote ? [replySegment(target.messageId!), ...sent.segments] : sent.segments;
      this.recordSent(session, await this.deps.client.sendMessage(session.target, segments), sent.text);
    }
    this.scheduleLearn(session, config.memory.learnDelayMs);
  }

  private scheduleLearn(session: Session, delay: number): void {
    if (!this.deps.memory) return;
    if (session.learnTimer) clearTimeout(session.learnTimer);
    session.learnTimer = setTimeout(() => void this.learn(session), delay);
  }

  private async learn(session: Session): Promise<void> {
    session.learnTimer = undefined;
    const records = session.history.since(session.learnedMark);
    session.learnedMark = session.history.total;
    if (!records.some((record) => !record.fromBot)) return;
    try {
      await this.deps.memory!.learn(session.scope, session.label, records, config.bot.name);
    } catch (error) {
      logger.warn(`[memory] ${session.key} 整理失败:`, (error as Error).message);
    }
  }

  // A failed forward falls back to plain lines so the reply still arrives.
  private async sendForward(session: Session, text: string, members: Map<string, number>): Promise<void> {
    const node: Segment = {
      type: "node",
      data: {
        user_id: String(this.deps.client.selfId ?? 0),
        nickname: config.bot.name,
        content: textToSegments(text, members),
      },
    };
    try {
      this.recordSent(session, await this.deps.client.sendForward(session.target, [node]), `[合并转发]\n${text}`);
    } catch (error) {
      logger.warn(`[send] ${session.key} 合并转发失败，改为逐条发送:`, (error as Error).message);
      for (const line of text.split("\n").filter(Boolean)) {
        await sleep(typingDelay({ kind: "text", text: line }));
        this.recordSent(session, await this.deps.client.sendMessage(session.target, textToSegments(line, members)), line);
      }
    }
  }

  private recordSent(session: Session, messageId: number | undefined, text: string): void {
    session.history.add({
      messageId,
      userId: this.deps.client.selfId ?? 0,
      name: config.bot.name,
      text,
      time: Date.now(),
      fromBot: true,
      atBot: false,
      replyToBot: false,
      mentionsBot: false,
    });
    logger.info(`[send] ${session.key} ${text}`);
  }

  // Display name -> QQ number for members of this group, so "@名字" in a reply becomes a real mention.
  private members(session: Session): Map<string, number> {
    const members = new Map<string, number>();
    if (session.target.groupId === undefined) return members;
    const prefix = `${session.target.groupId}:`;
    for (const [key, name] of this.memberNames) {
      if (key.startsWith(prefix)) members.set(name, Number(key.slice(prefix.length)));
    }
    return members;
  }

  private async describeMedia(segments: Segment[]): Promise<Map<Segment, string>> {
    const descriptions = new Map<Segment, string>();
    await Promise.all(
      segments.map(async (segment) => {
        const source = isSticker(segment) ? this.deps.stickers : this.deps.images;
        const description = await source?.observe(segment).catch(() => undefined);
        if (description) descriptions.set(segment, description);
      }),
    );
    return descriptions;
  }

  private async toSegments(
    part: ReplyPart,
    members: Map<string, number>,
  ): Promise<{ segments: Segment[]; text: string } | undefined> {
    if (part.kind === "text") return { segments: textToSegments(part.text, members), text: part.text };
    const sticker = this.deps.stickers?.byId(part.id);
    if (!sticker) {
      logger.warn(`[send] 表情包 #${part.id} 不存在，跳过`);
      return undefined;
    }
    return { segments: [await this.deps.stickers!.toSegment(sticker)], text: `[表情包：${sticker.description}]` };
  }
}

// Roughly how long a person takes to type the next message.
function typingDelay(part: ReplyPart): number {
  const base = part.kind === "sticker" ? 700 : Math.min(3500, 500 + part.text.length * 100);
  return base + Math.floor(Math.random() * 400);
}

function formatDecision(decision: GateDecision): string {
  const scores = decision.scores
    ? ` reply=${decision.scores.reply.toFixed(2)} addressed=${decision.scores.addressed.toFixed(2)} search=${decision.scores.search.toFixed(2)} threshold=${decision.scores.threshold.toFixed(2)}`
    : "";
  return `${decision.reply ? "REPLY" : "skip"} (${decision.source}: ${decision.reason})${scores}`;
}

function summarize(records: ChatRecord[]): string {
  return records.map((record) => `${record.name}: ${record.text}`.slice(0, 60)).join(" | ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
