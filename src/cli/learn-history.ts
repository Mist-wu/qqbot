import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config } from "../config.js";
import { MemoryStore } from "../chat/memory.js";
import { recordsFromHistory } from "./records.js";
import { completeJson } from "../llm/deepseek.js";
import { NapcatClient } from "../napcat/client.js";
import type { MessageEvent } from "../napcat/types.js";

export type HistoryClient = {
  whenOpen(): Promise<void>;
  callAction<T = unknown>(action: string, params?: Record<string, unknown>): Promise<{ data: T }>;
  shutdown(): Promise<void>;
};

export type LearnHistoryDeps = {
  client: HistoryClient;
  memory: Pick<MemoryStore, "learn" | "flush">;
  count: number;
  groups: Iterable<number>;
  privateUsers: Iterable<number>;
  botName: string;
  aliases?: string[];
  log?: (line: string) => void;
};

// One-off: learn memories from recent NapCat history of the whitelisted chats. Stop the bot first,
// otherwise its own memory flush overwrites what this writes.
export async function runLearnHistory(deps: LearnHistoryDeps): Promise<{ exitCode: number; errors: string[] }> {
  const errors: string[] = [];
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    await deps.client.whenOpen();
    const login = await deps.client.callAction<{ user_id: number }>("get_login_info");
    const selfId = login.data.user_id;
    const aliases = deps.aliases ?? [];

    for (const userId of deps.privateUsers) {
      const history = await deps.client.callAction<{ messages: MessageEvent[] }>("get_friend_msg_history", {
        user_id: userId,
        count: deps.count,
      });
      const records = recordsFromHistory(history.data.messages ?? [], selfId, deps.botName, aliases);
      const label = records.find((record) => !record.fromBot)?.name ?? String(userId);
      log(`私聊 ${userId}: ${records.length} 条，更新 ${await deps.memory.learn("private", label, records, deps.botName)} 人`);
    }

    for (const groupId of deps.groups) {
      const history = await deps.client.callAction<{ messages: MessageEvent[] }>("get_group_msg_history", {
        group_id: groupId,
        count: deps.count,
      });
      const info = await deps.client.callAction<{ group_name?: string }>("get_group_info", { group_id: groupId });
      const records = recordsFromHistory(history.data.messages ?? [], selfId, deps.botName, aliases);
      log(
        `群 ${groupId}: ${records.length} 条，更新 ${await deps.memory.learn("group", info.data.group_name ?? String(groupId), records, deps.botName)} 人`,
      );
    }
  } catch (error) {
    errors.push((error as Error).message);
  } finally {
    try {
      await deps.memory.flush();
    } catch (error) {
      errors.push(`保存记忆失败：${(error as Error).message}`);
    }
    try {
      await deps.client.shutdown();
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  return { exitCode: errors.length > 0 ? 1 : 0, errors };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = import.meta.url;
  if (here === pathToFileURL(resolve(entry)).href) return true;
  try {
    return here === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 60);
  if (!Number.isInteger(count) || count <= 0) {
    console.error(`条数必须是正整数：${process.argv[2]}`);
    process.exitCode = 1;
    return;
  }
  if (!config.deepseek.apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY");
    process.exitCode = 1;
    return;
  }

  const client = new NapcatClient(() => undefined);
  const memory = new MemoryStore(config.memory.file, completeJson);
  await memory.load();
  client.connect();
  const result = await runLearnHistory({
    client,
    memory,
    count,
    groups: config.bot.groups,
    privateUsers: config.bot.privateUsers,
    botName: config.bot.name,
    aliases: config.bot.aliases,
  });
  for (const line of result.errors) console.error(line);
  process.exitCode = result.exitCode;
}

if (isDirectRun()) void main();
