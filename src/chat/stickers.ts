import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Segment } from "../napcat/types.js";

export type Sticker = {
  id: number;
  key: string;
  file: string;
  mime: string;
  // Market faces are resent as mface so they keep QQ's native look.
  mface?: Record<string, unknown>;
  description: string;
  seen: number;
  used: number;
  lastSeen: number;
};

export type Describe = (dataUrl: string) => Promise<string>;

const MAX_BYTES = 3 * 1024 * 1024;
const DESCRIBE_PROMPT =
  "这是聊天里的一个表情包。用一句话说出它表达的情绪或意思。图上有文字就把文字原样写进这句话；没有文字就不要提文字。只输出这句话。";

// Vision output often notes the absence of text ("（图中无文字）"), which is noise in chat context.
export function cleanDescription(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[（(][^（）()]*(?:无|没有)[^（）()]*文字[^（）()]*[）)]/g, "")
    .replace(/(?:图片|图中|图上|图内|画面)?(?:中|上|里)?(?:没有|无)(?:任何)?文字[，,、；;。]?/g, "")
    .replace(/^[，,、；;\s]+/, "")
    .trim();
}

function stickerKey(segment: Segment): string | undefined {
  if (segment.type === "mface") {
    const id = segment.data.emoji_id ?? segment.data.key;
    return id ? `mface:${String(id)}` : undefined;
  }
  const source = segment.data.file ?? segment.data.url;
  return typeof source === "string" && source ? `image:${source}` : undefined;
}

export function sniffMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

export class StickerStore {
  private stickers = new Map<string, Sticker>();
  private inflight = new Map<string, Promise<Sticker | undefined>>();
  private nextId = 1;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly dir: string,
    private readonly describe: Describe,
    private readonly maxStickers = config.stickers.max,
  ) {}

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const list = JSON.parse(await readFile(join(this.dir, "index.json"), "utf8")) as Sticker[];
      for (const sticker of list) this.stickers.set(sticker.key, { ...sticker, description: cleanDescription(sticker.description) });
      this.nextId = Math.max(0, ...list.map((sticker) => sticker.id)) + 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get size(): number {
    return this.stickers.size;
  }

  // Returns the sticker's description, collecting and describing it the first time it is seen.
  async observe(segment: Segment): Promise<string | undefined> {
    const key = stickerKey(segment);
    if (!key) return undefined;
    const known = this.stickers.get(key);
    if (known) {
      known.seen++;
      known.lastSeen = Date.now();
      this.scheduleSave();
      return known.description;
    }
    let task = this.inflight.get(key);
    if (!task) {
      task = this.collect(key, segment).finally(() => this.inflight.delete(key));
      this.inflight.set(key, task);
    }
    return (await task)?.description;
  }

  list(limit = config.stickers.promptLimit): Sticker[] {
    return [...this.stickers.values()]
      .sort((a, b) => b.seen + b.used * 2 - (a.seen + a.used * 2) || b.lastSeen - a.lastSeen)
      .slice(0, limit);
  }

  byId(id: number): Sticker | undefined {
    for (const sticker of this.stickers.values()) if (sticker.id === id) return sticker;
    return undefined;
  }

  async toSegment(sticker: Sticker): Promise<Segment> {
    sticker.used++;
    this.scheduleSave();
    if (sticker.mface) return { type: "mface", data: sticker.mface };
    const bytes = await readFile(join(this.dir, sticker.file));
    return { type: "image", data: { file: `base64://${bytes.toString("base64")}`, sub_type: 1, summary: "[动画表情]" } };
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const tmp = join(this.dir, `index.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify([...this.stickers.values()], null, 2));
    await rename(tmp, join(this.dir, "index.json"));
  }

  private async collect(key: string, segment: Segment): Promise<Sticker | undefined> {
    const url = typeof segment.data.url === "string" ? segment.data.url : undefined;
    if (!url) return undefined;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`下载失败 ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_BYTES) throw new Error(`太大 ${bytes.length}`);
      const mime = sniffMime(bytes);
      if (!mime) throw new Error("不是可识别的图片");

      const description = cleanDescription(await this.describe(`data:${mime};base64,${bytes.toString("base64")}`));
      if (!description) throw new Error("描述为空");

      const file = `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.${mime.split("/")[1]}`;
      await writeFile(join(this.dir, file), bytes);
      const sticker: Sticker = {
        id: this.nextId++,
        key,
        file,
        mime,
        description,
        seen: 1,
        used: 0,
        lastSeen: Date.now(),
      };
      if (segment.type === "mface") {
        const { emoji_id, emoji_package_id, key: faceKey, summary } = segment.data;
        sticker.mface = { emoji_id, emoji_package_id, key: faceKey, summary };
      }
      this.stickers.set(key, sticker);
      await this.evict();
      this.scheduleSave();
      logger.info(`[sticker] 收藏 #${sticker.id} ${description}`);
      return sticker;
    } catch (error) {
      logger.debug(`[sticker] 跳过 ${key}:`, (error as Error).message);
      return undefined;
    }
  }

  private async evict(): Promise<void> {
    if (this.stickers.size <= this.maxStickers) return;
    const victims = [...this.stickers.values()]
      .sort((a, b) => a.seen + a.used * 2 - (b.seen + b.used * 2) || a.lastSeen - b.lastSeen)
      .slice(0, this.stickers.size - this.maxStickers);
    for (const victim of victims) {
      this.stickers.delete(victim.key);
      await unlink(join(this.dir, victim.file)).catch(() => undefined);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch((error) => logger.warn("[sticker] 保存索引失败:", (error as Error).message));
    }, 2000);
  }
}

export function describeSticker(describeImage: (dataUrl: string, instruction: string) => Promise<string>): Describe {
  return (dataUrl) => describeImage(dataUrl, DESCRIBE_PROMPT);
}
