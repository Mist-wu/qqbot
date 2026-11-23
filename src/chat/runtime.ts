import { setTimeout as sleep } from "node:timers/promises";

import { config } from "../config.js";
import { logger } from "../logger.js";
import type { NapcatClient, SendTarget } from "../napcat/client.js";
import {
  isSticker,
  renderSegments,
  replySegment,
  replyTargetId,
  textSegment,
  textToSegments,
  toSegments,
} from "../napcat/message.js";
import type { MessageEvent, Segment } from "../napcat/types.js";
import { PRESENCE_WINDOW_MS, decide, type GateDecision, type Judge } from "./gate.js";
import { SessionHistory, formatLine, presenceOf, recordFromMessage, type ChatRecord, type Quote, type Scope } from "./history.js";
import type { ImageDescriber } from "./images.js";
import type { MemoryStore } from "./memory.js";
import type { PowerSwitch } from "./power.js";
import { dropRepeatedEndings, generateReply, hasLink, planSends, type ReplyPart } from "./reply.js";
import type { StickerStore } from "./stickers.js";
import type { VoiceTranscriber } from "./voices.js";

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

type RuntimeDeps = {
  client: Pick<NapcatClient, "selfId" | "sendMessage" | "sendForward" | "callAction">;
  power: Pick<PowerSwitch, "on" | "set">;
  judge?: Judge | undefined;
  stickers?: StickerStore | undefined;
  images?: ImageDescriber | undefined;
  voices?: VoiceTranscriber | undefined;
  // Text to speech for voice lines in a reply; without it they go out as text.
  speak?: ((text: string) => Promise<Buffer>) | undefined;
  memory?: MemoryStore | undefined;
};

const COMMANDS = new Map([
  ["/启动", true],
  ["/停止", false],
]);

const MEDIA_WAIT_MS = 8000;
const MEDIA_TYPES = new Set(["image", "mface", "record"]);

export class ChatRuntime {
  private readonly sessions = new Map<string, Session>();
  // Group card or nickname by "groupId:userId", learned from senders and member lookups.
  private readonly memberNames = new Map<string, string>();
  private commandChain: Promise<void> = Promise.resolve();
  // Successful /停止 bumps this. Work that started earlier never sends, saves or learns, even after /启动.
  private epoch = 0;

  constructor(private readonly deps: RuntimeDeps) {}

  private current(epoch: number): boolean {
    return epoch === this.epoch && this.deps.power.on;
  }

  handle(event: MessageEvent): void {
    const selfId = this.deps.client.selfId ?? event.self_id;
    if (event.user_id === selfId) return;
    if (event.message_type === "private" && config.bot.adminUsers.has(event.user_id)) {
      const command = renderSegments(toSegments(event.message), { botName: config.bot.name });
      const on = COMMANDS.get(command);
      if (on !== undefined) {
        this.commandChain = this.commandChain.then(() => this.applyCommand(event.user_id, on)).catch((error) => {
          logger.error("[admin] 命令执行失败:", error);
        });
        return;
      }
    }
    // Stopped means not taking part at all: nothing is judged, stored or learned.
    if (!this.deps.power.on) return;
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
    const record = recordFromMessage(event, segments, renderContext);
    if (!record.text) return;
    if (!event.time) record.time = Date.now();

    const session = this.session(event);
    const epoch = this.epoch;
    const commit = () => this.current(epoch);
    const replyTo = replyTargetId(segments);
    record.replyToBot = replyTo !== undefined && session.history.isBotMessage(replyTo);

    // A quoted message is found in history when possible, otherwise fetched from NapCat.
    const known = replyTo !== undefined ? session.history.byId(replyTo) : undefined;
    if (known) record.quote = { name: known.name, text: known.text, fromBot: known.fromBot };
    const media = segments.filter((seg) => MEDIA_TYPES.has(seg.type));
    const unknownNames = groupId === undefined ? [] : [...record.mentions.keys()].filter((id) => !atName(id));
    const fetchQuote = replyTo !== undefined && !known;
    if (media.length > 0 || unknownNames.length > 0 || fetchQuote) {
      record.ready = Promise.all([
        this.describeMedia(media, commit),
        fetchQuote
          ? this.fetchQuote(replyTo!, selfId, atName, commit).then((found) => {
              record.quote = found;
              if (found?.fromBot) record.replyToBot = true;
            })
          : undefined,
        ...unknownNames.map((userId) => this.lookupMember(groupId!, userId)),
      ]).then(([descriptions]) => {
        record.text = renderSegments(segments, { ...renderContext, mediaText: (seg) => descriptions.get(seg) });
        for (const id of unknownNames) {
          if (!record.mentions.get(id)) record.mentions.set(id, atName(id));
        }
      });
    }
    session.history.add(record);
    session.pending.push(record);
    this.schedule(session);
    // Batch learning only where the bot has been part of the conversation recently.
    const engaged = session.history.presence(config.memory.engagedWindowMs, Date.now()).bot > 0;
    if (engaged && session.history.total - session.learnedMark >= config.memory.learnBatch) this.scheduleLearn(session, 0, epoch);
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

  private async applyCommand(userId: number, on: boolean): Promise<void> {
    const power = this.deps.power;
    let reply: string;
    if (power.on === on) {
      reply = on ? `${config.bot.name} 已经在运行` : `${config.bot.name} 已经是停止状态`;
    } else {
      try {
        await power.set(on);
        if (!on) this.invalidate();
        reply = on ? `${config.bot.name} 已启动` : `${config.bot.name} 已停止，群聊和私聊都不再回复，发 /启动 恢复`;
      } catch (error) {
        logger.error("[admin] 保存开关状态失败:", (error as Error).message);
        reply = "保存开关状态失败，请检查日志";
      }
    }
    logger.info(`[admin] ${userId} ${on ? "/启动" : "/停止"} -> ${reply}`);
    try {
      await this.deps.client.sendMessage({ userId }, [textSegment(reply)]);
    } catch (error) {
      logger.warn("[admin] 回复失败:", (error as Error).message);
    }
  }

  private invalidate(): void {
    this.epoch++;
    for (const session of this.sessions.values()) {
      if (session.timer) clearTimeout(session.timer);
      if (session.learnTimer) clearTimeout(session.learnTimer);
      session.timer = undefined;
      session.learnTimer = undefined;
      session.pending = [];
      session.firstPendingAt = undefined;
    }
  }

  private async fetchQuote(
    messageId: number,
    selfId: number,
    atName: (userId: number) => string | undefined,
    commit: () => boolean,
  ): Promise<Quote | undefined> {
    try {
      const { data } = await this.deps.client.callAction<{
        user_id?: number;
        sender?: { card?: string; nickname?: string };
        message?: Segment[] | string;
      }>("get_msg", { message_id: messageId });
      const segments = toSegments(data?.message);
      const descriptions = await this.describeMedia(
        segments.filter((seg) => MEDIA_TYPES.has(seg.type)),
        commit,
      );
      const text = renderSegments(segments, {
        selfId,
        botName: config.bot.name,
        atName,
        mediaText: (seg) => descriptions.get(seg),
      });
      if (!text) return undefined;
      const fromBot = data?.user_id === selfId;
      const name = fromBot ? config.bot.name : data?.sender?.card || data?.sender?.nickname || "某人";
      return { name, text, fromBot };
    } catch (error) {
      logger.debug(`获取引用消息失败 ${messageId}:`, (error as Error).message);
      return undefined;
    }
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
    if (session.pending.length === 0) return;
    const now = Date.now();
    session.firstPendingAt ??= now;
    if (session.busy || !this.deps.power.on) return;
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
    const epoch = this.epoch;
    if (!this.current(epoch)) {
      session.pending = [];
      session.firstPendingAt = undefined;
      return;
    }
    session.busy = true;
    const pending = session.pending.splice(0);
    session.firstPendingAt = undefined;
    const pendingSet = new Set(pending);
    const kept = session.history.since(0).filter((record) => !pendingSet.has(record));
    const earlier = kept.slice(-config.history.contextMessages);
    const presenceRecords = [...kept, ...pending];
    try {
      const ready = pending.map((record) => record.ready).filter((task): task is Promise<void> => task !== undefined);
      if (ready.length > 0) {
        const ac = new AbortController();
        await Promise.race([
          Promise.all(ready),
          sleep(MEDIA_WAIT_MS, undefined, { signal: ac.signal }).catch(() => undefined),
        ]);
        ac.abort();
      }
      if (!this.current(epoch)) return;
      const now = Date.now();
      const decision = await decide(
        {
          scope: session.scope,
          sessionLabel: session.label,
          botName: config.bot.name,
          aliases: config.bot.aliases,
          persona: config.bot.persona,
          earlier,
          pending,
          presence: presenceOf(presenceRecords, PRESENCE_WINDOW_MS, now),
          now,
        },
        this.deps.judge,
      );
      if (!this.current(epoch)) return;
      logger.info(`[gate] ${session.key} ${formatDecision(decision)} :: ${summarize(pending)}`);
      if (decision.reply) await this.reply(session, earlier, pending, decision.search, epoch);
    } catch (error) {
      logger.error(`[chat] ${session.key} 处理失败:`, (error as Error).message);
    } finally {
      session.busy = false;
      this.schedule(session);
    }
  }

  private async reply(
    session: Session,
    earlier: ChatRecord[],
    pending: ChatRecord[],
    withSearch: boolean,
    epoch: number,
  ): Promise<void> {
    const records = [...earlier, ...pending];
    const generated = await generateReply({
      scope: session.scope,
      sessionLabel: session.label,
      botName: config.bot.name,
      persona: config.bot.persona,
      earlier,
      pending,
      stickers: this.deps.stickers?.list() ?? [],
      memories: this.deps.memory?.describe(records) ?? [],
      now: Date.now(),
      search: withSearch && config.search.enabled,
      readLinks: config.search.readLinks && hasLink(pending),
      voice: this.deps.speak !== undefined,
    });
    if (!this.current(epoch)) return;
    const recentBot = records.filter((record) => record.fromBot).map((record) => record.text);
    const parts = dropRepeatedEndings(generated, recentBot);
    if (parts.length === 0) {
      logger.info(`[chat] ${session.key} 模型选择不回复`);
      return;
    }

    const target = pending.findLast((record) => record.atBot || record.replyToBot) ?? pending.at(-1)!;
    // Quote only when the conversation moved on while the reply was being written.
    let needQuote =
      session.scope === "group" && target.messageId !== undefined && session.history.last() !== target;

    const members = this.members(session);
    const current = () => this.current(epoch);
    for (const [index, item] of planSends(parts).entries()) {
      if (index > 0) await sleep(item.kind === "forward" ? 1500 : typingDelay(item.part));
      if (!current()) return;
      if (item.kind === "forward") {
        needQuote = false;
        await this.sendForward(session, item.text, members, epoch);
        if (!current()) return;
        continue;
      }
      const sent = await this.toSegments(item.part, members);
      if (!current()) return;
      if (!sent) continue;
      const quoted = needQuote;
      needQuote = false;
      const segments = quoted ? [replySegment(target.messageId!), ...sent.segments] : sent.segments;
      const quoteOf = quoted ? { name: target.name, text: target.text, fromBot: false } : undefined;
      const messageId = await this.deps.client.sendMessage(session.target, segments, current);
      if (messageId === undefined && !current()) return;
      this.recordSent(session, messageId, sent.text, quoteOf);
    }
    if (current()) this.scheduleLearn(session, config.memory.learnDelayMs, epoch);
  }

  private scheduleLearn(session: Session, delay: number, epoch: number): void {
    if (!this.deps.memory || !this.current(epoch)) return;
    if (session.learnTimer) clearTimeout(session.learnTimer);
    session.learnTimer = setTimeout(() => void this.learn(session, epoch), delay);
  }

  private async learn(session: Session, epoch: number): Promise<void> {
    session.learnTimer = undefined;
    if (!this.current(epoch)) return;
    const records = session.history.since(session.learnedMark);
    session.learnedMark = session.history.total;
    try {
      await this.deps.memory!.learn(session.scope, session.label, records, config.bot.name, () => this.current(epoch));
    } catch (error) {
      logger.warn(`[memory] ${session.key} 整理失败:`, (error as Error).message);
    }
  }

  // A failed forward falls back to plain lines so the reply still arrives.
  private async sendForward(session: Session, text: string, members: Map<string, number>, epoch: number): Promise<void> {
    const current = () => this.current(epoch);
    const node: Segment = {
      type: "node",
      data: {
        user_id: String(this.deps.client.selfId ?? 0),
        nickname: config.bot.name,
        content: textToSegments(text, members),
      },
    };
    try {
      const messageId = await this.deps.client.sendForward(session.target, [node], current);
      if (messageId === undefined && !current()) return;
      this.recordSent(session, messageId, `[合并转发]\n${text}`);
    } catch (error) {
      logger.warn(`[send] ${session.key} 合并转发失败，改为逐条发送:`, (error as Error).message);
      for (const line of text.split("\n").filter(Boolean)) {
        await sleep(typingDelay({ kind: "text", text: line }));
        if (!current()) return;
        const messageId = await this.deps.client.sendMessage(session.target, textToSegments(line, members), current);
        if (messageId === undefined && !current()) return;
        this.recordSent(session, messageId, line);
      }
    }
  }

  private recordSent(session: Session, messageId: number | undefined, text: string, quote?: Quote): void {
    session.history.add({
      quote,
      messageId,
      userId: this.deps.client.selfId ?? 0,
      name: config.bot.name,
      text,
      time: Date.now(),
      fromBot: true,
      atBot: false,
      replyToBot: false,
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

  private async describeMedia(segments: Segment[], commit: () => boolean): Promise<Map<Segment, string>> {
    const descriptions = new Map<Segment, string>();
    await Promise.all(
      segments.map(async (segment) => {
        const source =
          segment.type === "record" ? this.deps.voices : isSticker(segment) ? this.deps.stickers : this.deps.images;
        const description = await source?.observe(segment, commit).catch(() => undefined);
        if (description) descriptions.set(segment, description);
      }),
    );
    return descriptions;
  }

  // Voice lines become a record message; a failed synthesis sends the line as text instead.
  private async voiceSegments(text: string, members: Map<string, number>): Promise<{ segments: Segment[]; text: string }> {
    if (this.deps.speak) {
      try {
        const audio = await this.deps.speak(text);
        return { segments: [{ type: "record", data: { file: `base64://${audio.toString("base64")}` } }], text: `[语音：${text}]` };
      } catch (error) {
        logger.warn("[send] 语音合成失败，改发文字:", (error as Error).message);
      }
    }
    return { segments: textToSegments(text, members), text };
  }

  private async toSegments(
    part: ReplyPart,
    members: Map<string, number>,
  ): Promise<{ segments: Segment[]; text: string } | undefined> {
    if (part.kind === "text") return { segments: textToSegments(part.text, members), text: part.text };
    if (part.kind === "voice") return this.voiceSegments(part.text, members);
    const sticker = this.deps.stickers?.byId(part.id);
    if (!sticker) {
      logger.warn(`[send] 表情包 #${part.id} 不存在，跳过`);
      return undefined;
    }
    try {
      return { segments: [await this.deps.stickers!.toSegment(sticker)], text: `[表情包：${sticker.description}]` };
    } catch (error) {
      logger.warn(`[send] 表情包 #${part.id} 读取失败，跳过:`, (error as Error).message);
      return undefined;
    }
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
  return records.map((record) => formatLine(record, record.name, config.bot.name).slice(0, 80)).join(" | ");
}
