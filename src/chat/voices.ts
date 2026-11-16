import { readFile } from "node:fs/promises";

import { config } from "../config.js";
import { logger } from "../logger.js";
import type { NapcatClient } from "../napcat/client.js";
import type { Segment } from "../napcat/types.js";

export type Transcribe = (audio: Buffer) => Promise<string>;

type RecordFile = { file?: string; base64?: string };

const MAX_CACHE = 500;
const MAX_CHARS = 500;

// Transcribes voice messages so the chat can follow what was said. NapCat converts QQ's silk audio
// to WAV; its reply carries base64 or, when NapCat runs on the same machine, a local path.
export class VoiceTranscriber {
  private readonly cache = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly client: Pick<NapcatClient, "callAction">,
    private readonly transcribe: Transcribe,
  ) {}

  observe(segment: Segment): Promise<string | undefined> {
    const file = typeof segment.data.file === "string" && segment.data.file ? segment.data.file : undefined;
    if (!file) return Promise.resolve(undefined);
    let task = this.cache.get(file);
    if (!task) {
      task = this.run(file);
      this.cache.set(file, task);
      if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    }
    return task;
  }

  private async run(file: string): Promise<string | undefined> {
    try {
      const audio = await this.download(file);
      if (audio.length > config.voices.maxBytes) throw new Error(`太大 ${audio.length}`);
      const text = (await this.transcribe(audio)).replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
      if (text) logger.info(`[voice] ${text}`);
      return text || undefined;
    } catch (error) {
      logger.debug("[voice] 跳过:", (error as Error).message);
      return undefined;
    }
  }

  private async download(file: string): Promise<Buffer> {
    const { data } = await this.client.callAction<RecordFile>("get_record", { file, out_format: "wav" });
    if (data?.base64) return Buffer.from(data.base64, "base64");
    if (data?.file) return readFile(data.file);
    throw new Error("get_record 没有返回音频");
  }
}
