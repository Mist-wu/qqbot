import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Segment } from "../napcat/types.js";
import { MediaCache } from "./media-cache.js";
import { cleanDescription, dataUrl, downloadImage, type Describe } from "./media.js";

const DESCRIBE_PROMPT = "这是聊天里有人发的一张图片。用一两句话说清楚图里是什么；图上有文字就把关键文字写进来。只输出描述。";
const MAX_CHARS = 300;

// Describes ordinary pictures so the chat can refer to them; unlike stickers nothing is kept on disk.
export class ImageDescriber {
  constructor(
    private readonly describe: Describe,
    private readonly cache = new MediaCache(),
  ) {}

  observe(segment: Segment, _commit?: () => boolean): Promise<string | undefined> {
    const url = typeof segment.data.url === "string" ? segment.data.url : undefined;
    if (!url) return Promise.resolve(undefined);
    const key = typeof segment.data.file === "string" && segment.data.file ? segment.data.file : url;
    return this.cache.get(`image:${key}`, () => this.run(url));
  }

  private async run(url: string): Promise<string | undefined> {
    try {
      const image = await downloadImage(url, config.images.maxBytes);
      const description = cleanDescription(await this.describe(dataUrl(image), DESCRIBE_PROMPT)).slice(0, MAX_CHARS);
      if (description) logger.info(`[image] ${description}`);
      return description || undefined;
    } catch (error) {
      logger.debug("[image] 跳过:", (error as Error).message);
      return undefined;
    }
  }
}
