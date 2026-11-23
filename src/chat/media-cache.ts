import { logger } from "../logger.js";

// Shared by picture descriptions and voice transcripts. A failure is dropped so the next look retries.
export class MediaCache {
  private readonly slots = new Map<string, Promise<string | undefined>>();

  constructor(private readonly max = 500) {}

  get(kind: "image" | "voice", file: string, load: () => Promise<string>): Promise<string | undefined> {
    const key = `${kind}:${file}`;
    const existing = this.slots.get(key);
    if (existing) return existing;
    const pending = load().catch((error: unknown) => {
      logger.debug(`[${kind}] 跳过:`, error instanceof Error ? error.message : error);
      return undefined;
    }).then((text) => {
      if (text) {
        logger.info(`[${kind}] ${text}`);
        return text;
      }
      if (this.slots.get(key) === pending) this.slots.delete(key);
      return undefined;
    });
    this.slots.set(key, pending);
    if (this.slots.size > this.max) {
      const oldest = this.slots.keys().next().value;
      if (oldest !== undefined && oldest !== key) this.slots.delete(oldest);
    }
    return pending;
  }
}
