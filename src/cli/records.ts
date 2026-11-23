import { recordFromMessage, type ChatRecord } from "../chat/history.js";
import { replyTargetId, toSegments } from "../napcat/message.js";
import type { MessageEvent } from "../napcat/types.js";

// Fields that can be known from this history page only. Missing audio and off-page quotes stay placeholders.
export function recordsFromHistory(
  messages: MessageEvent[],
  selfId: number,
  botName: string,
): ChatRecord[] {
  const names = new Map<number, string>();
  for (const event of messages) {
    if (event.user_id === selfId) continue;
    const name = event.sender?.card || event.sender?.nickname;
    if (name) names.set(event.user_id, name);
  }
  const ctx = { selfId, botName, atName: (id: number) => names.get(id) };
  const records: ChatRecord[] = [];
  const replies = new Map<ChatRecord, number>();
  const byId = new Map<number, ChatRecord>();

  for (const event of messages) {
    const segments = toSegments(event.message);
    const record = recordFromMessage(event, segments, ctx);
    if (!record.text) continue;
    records.push(record);
    const replyTo = replyTargetId(segments);
    if (replyTo !== undefined) replies.set(record, replyTo);
    byId.set(event.message_id, record);
  }

  for (const [record, replyTo] of replies) {
    const quoted = byId.get(replyTo);
    if (!quoted || quoted === record) continue;
    record.quote = { name: quoted.name, text: quoted.text, fromBot: quoted.fromBot };
    record.replyToBot = quoted.fromBot;
  }
  return records;
}
