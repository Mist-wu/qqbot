import { readFile } from "node:fs/promises";

import { config } from "../config.js";
import type { NapcatClient } from "../napcat/client.js";
import type { Segment } from "../napcat/types.js";
import { MediaCache } from "./media-cache.js";

type Transcribe = (audio: Buffer) => Promise<string>;

type RecordFile = { file?: string; base64?: string };

const MAX_CHARS = 500;

// Transcribes voice messages so the chat can follow what was said. NapCat converts QQ's silk audio
// to WAV; its reply carries base64 or, when NapCat runs on the same machine, a local path.
export class VoiceTranscriber {
  constructor(
    private readonly client: Pick<NapcatClient, "callAction">,
    private readonly transcribe: Transcribe,
    private readonly cache = new MediaCache(),
  ) {}

  observe(segment: Segment): Promise<string | undefined> {
    const file = segment.data.file;
    if (typeof file !== "string" || !file) return Promise.resolve(undefined);
    return this.cache.get("voice", file, async () => {
      const audio = await this.download(file);
      if (audio.length > config.voices.maxBytes) throw new Error(`太大 ${audio.length}`);
      return (await this.transcribe(audio)).replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
    });
  }

  private async download(file: string): Promise<Buffer> {
    const { data } = await this.client.callAction<RecordFile>("get_record", { file, out_format: "wav" });
    if (data?.base64) return Buffer.from(data.base64, "base64");
    if (data?.file) return readFile(data.file);
    throw new Error("get_record 没有返回音频");
  }
}
