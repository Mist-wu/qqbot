import type { ChatRecord } from "../chat/history.js";
import { atTargets, isAtSelf, renderSegments, replyTargetId, toSegments } from "../napcat/message.js";
import type { MessageEvent, Segment } from "../napcat/types.js";

function atLabel(segments: Segment[], userId: number, names: Map<number, string>): string {
  for (const segment of segments) {
    if (segment.type !== "at" || Number(segment.data.qq) !== userId) continue;
    if (typeof segment.data.name === "string" && segment.data.name) return segment.data.name;
  }
  return names.get(userId) ?? "某人";
}

// Fields that can be known from this history page only. Missing audio and off-page quotes stay placeholders.
export function recordsFromHistory(
  messages: MessageEvent[],
  selfId: number,
  botName: string,
  aliases: string[] = [],
): ChatRecord[] {
  const names = new Map<number, string>();
  for (const event of messages) {
    if (event.user_id === selfId) continue;
    const name = event.sender?.card || event.sender?.nickname;
    if (name) names.set(event.user_id, name);
  }
  const knownNames = [botName, ...aliases].filter(Boolean);
  const drafts: { record: ChatRecord; replyTo?: number }[] = [];
  const byId = new Map<number, ChatRecord>();

  for (const event of messages) {
    const segments = toSegments(event.message);
    const text = renderSegments(segments, { selfId, botName, atName: (userId) => names.get(userId) });
    if (!text) continue;
    const fromBot = event.user_id === selfId;
    const mentions = atTargets(segments, selfId);
    const record: ChatRecord = {
      messageId: event.message_id,
      userId: event.user_id,
      name: fromBot ? botName : event.sender?.card || event.sender?.nickname || String(event.user_id),
      text,
      time: event.time * 1000,
      fromBot,
      atBot: isAtSelf(segments, selfId),
      replyToBot: false,
      mentionsBot: knownNames.some((name) => text.includes(name)),
      mentions,
      mentionNames: mentions.map((userId) => atLabel(segments, userId, names)),
    };
    drafts.push({ record, replyTo: replyTargetId(segments) });
    if (record.messageId !== undefined) byId.set(record.messageId, record);
  }

  for (const draft of drafts) {
    if (draft.replyTo === undefined) continue;
    const quoted = byId.get(draft.replyTo);
    if (!quoted || quoted === draft.record) continue;
    draft.record.quote = { name: quoted.name, text: quoted.text, fromBot: quoted.fromBot };
    if (quoted.fromBot) draft.record.replyToBot = true;
  }
  return drafts.map((draft) => draft.record);
}
