import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";
import type { ChatRecord, Scope } from "./history.js";

// Facts are kept per scope so a reply can tell what was said in private.
export type Person = {
  userId: number;
  name: string;
  group: string[];
  private: string[];
  updatedAt: number;
};

export type ExtractJson = (system: string, user: string) => Promise<unknown>;

const MAX_FACT_CHARS = 120;

function clock(time: number): string {
  return new Date(time).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" });
}

export class MemoryStore {
  private readonly people = new Map<number, Person>();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly file: string,
    private readonly extract: ExtractJson,
  ) {}

  async load(): Promise<void> {
    try {
      const list = JSON.parse(await readFile(this.file, "utf8")) as Person[];
      for (const person of list) this.people.set(person.userId, person);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get size(): number {
    return this.people.size;
  }

  get(userId: number): Person | undefined {
    return this.people.get(userId);
  }

  // One line per person who speaks or is @-mentioned in these records and has memories.
  describe(records: ChatRecord[]): string[] {
    const lines: string[] = [];
    const seen = new Set<number>();
    const add = (userId: number, name: string) => {
      if (seen.has(userId)) return;
      seen.add(userId);
      const person = this.people.get(userId);
      if (!person || person.group.length + person.private.length === 0) return;
      const parts = [...person.group];
      if (person.private.length > 0) parts.push(`私聊里告诉你的：${person.private.join("；")}`);
      lines.push(`${name}：${parts.join("；")}`);
    };
    for (const record of records) {
      if (!record.fromBot) add(record.userId, record.name);
      for (const userId of record.mentions ?? []) add(userId, this.people.get(userId)?.name ?? "");
    }
    return lines;
  }

  async learn(scope: Scope, label: string, records: ChatRecord[], botName: string): Promise<number> {
    const speakers = new Map<number, string>();
    for (const record of records) if (!record.fromBot) speakers.set(record.userId, record.name);
    if (speakers.size === 0) return 0;

    const known = [...speakers].map(([userId, name]) => {
      const facts = this.people.get(userId)?.[scope] ?? [];
      return `- ${name}（QQ ${userId}）：${facts.length > 0 ? facts.join("；") : "无"}`;
    });
    const transcript = records.map((record) => {
      const who = record.fromBot ? `${botName}（你）` : `${record.name}（QQ ${record.userId}）`;
      return `[${clock(record.time)}] ${who}：${record.text}`;
    });
    const system = [
      `你在整理「${botName}」对聊天对象的长期记忆：关于每个人自己的、以后聊天时用得上的信息。`,
      "结合新的聊天记录更新已有记忆，被纠正或过时的内容要改掉，不重要的不用记。",
      '只输出 JSON，格式为 {"people":[{"user_id":数字,"facts":["…"]}]}。只列出记忆有变化的人，facts 是这个人更新后的完整记忆。',
    ].join("\n");
    const user = [
      `场景：${scope === "group" ? `QQ群「${label}」` : `和「${label}」的QQ私聊`}`,
      "已有记忆：",
      ...known,
      "",
      "新的聊天记录：",
      ...transcript,
    ].join("\n");

    const result = (await this.extract(system, user)) as { people?: unknown };
    let updated = 0;
    for (const entry of Array.isArray(result?.people) ? result.people : []) {
      const userId = Number((entry as { user_id?: unknown }).user_id);
      const rawFacts = (entry as { facts?: unknown }).facts;
      // Only people who actually spoke here can be updated, so a hallucinated id changes nothing.
      if (!speakers.has(userId) || !Array.isArray(rawFacts)) continue;
      const facts = [...new Set(rawFacts.filter((fact): fact is string => typeof fact === "string").map((fact) => fact.trim()))]
        .filter(Boolean)
        .map((fact) => fact.slice(0, MAX_FACT_CHARS))
        .slice(0, config.memory.maxFacts);
      const person = this.people.get(userId) ?? { userId, name: "", group: [], private: [], updatedAt: 0 };
      person.name = speakers.get(userId)!;
      person[scope] = facts;
      person.updatedAt = Date.now();
      this.people.set(userId, person);
      updated++;
      logger.info(`[memory] ${person.name}(${userId}) ${scope}: ${facts.join("；")}`);
    }
    if (updated > 0) this.scheduleSave();
    return updated;
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.people.values()], null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch((error) => logger.warn("[memory] 保存失败:", (error as Error).message));
    }, 2000);
  }
}
