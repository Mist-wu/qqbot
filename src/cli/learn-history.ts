import { config } from "../config.js";
import { MemoryStore } from "../chat/memory.js";
import type { ChatRecord } from "../chat/history.js";
import { completeJson } from "../llm/deepseek.js";
import { NapcatClient } from "../napcat/client.js";
import { renderSegments, toSegments } from "../napcat/message.js";
import type { MessageEvent } from "../napcat/types.js";

// One-off: learn memories from recent NapCat history of the whitelisted chats. Stop the bot first,
// otherwise its own memory flush overwrites what this writes.
const COUNT = Number(process.argv[2] ?? 60);

const client = new NapcatClient(() => undefined);
client.connect();
await new Promise((resolve) => setTimeout(resolve, 2000));
const login = await client.callAction<{ user_id: number }>("get_login_info");
const selfId = login.data.user_id;

const memory = new MemoryStore(config.memory.file, completeJson);
await memory.load();

function toRecords(messages: MessageEvent[]): ChatRecord[] {
  return messages
    .map((event) => ({
      messageId: event.message_id,
      userId: event.user_id,
      name: event.user_id === selfId ? config.bot.name : event.sender?.card || event.sender?.nickname || String(event.user_id),
      text: renderSegments(toSegments(event.message), { selfId, botName: config.bot.name }),
      time: event.time * 1000,
      fromBot: event.user_id === selfId,
      atBot: false,
      replyToBot: false,
      mentionsBot: false,
    }))
    .filter((record) => record.text);
}

for (const userId of config.bot.privateUsers) {
  const history = await client.callAction<{ messages: MessageEvent[] }>("get_friend_msg_history", { user_id: userId, count: COUNT });
  const records = toRecords(history.data.messages ?? []);
  const label = records.find((record) => !record.fromBot)?.name ?? String(userId);
  console.log(`私聊 ${userId}: ${records.length} 条，更新 ${await memory.learn("private", label, records, config.bot.name)} 人`);
}

for (const groupId of config.bot.groups) {
  const history = await client.callAction<{ messages: MessageEvent[] }>("get_group_msg_history", { group_id: groupId, count: COUNT });
  const info = await client.callAction<{ group_name?: string }>("get_group_info", { group_id: groupId });
  const records = toRecords(history.data.messages ?? []);
  console.log(`群 ${groupId}: ${records.length} 条，更新 ${await memory.learn("group", info.data.group_name ?? String(groupId), records, config.bot.name)} 人`);
}

await memory.flush();
await client.shutdown();
