import { config } from "./config.js";
import { createJevJudge } from "./chat/gate.js";
import { ChatRuntime } from "./chat/runtime.js";
import { ImageDescriber, describeImageWith } from "./chat/images.js";
import { MemoryStore } from "./chat/memory.js";
import { StickerStore, describeSticker } from "./chat/stickers.js";
import { DEEPSEEK_MODEL, completeJson, describeImage } from "./llm/deepseek.js";
import { logger } from "./logger.js";
import { NapcatClient } from "./napcat/client.js";
import { isMessageEvent } from "./napcat/types.js";
import { CodexAuth } from "./search/codex-auth.js";
import { CodexWebSearch } from "./search/web-search.js";

async function main(): Promise<void> {
  if (!config.deepseek.apiKey) {
    logger.error("缺少 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  const judge = config.jev.apiKey ? createJevJudge() : undefined;
  if (!judge) logger.warn("未设置 TYPESAFE_API_KEY：jev 不可用，只在私聊、@、回复、点名时发言");

  let search: CodexWebSearch | undefined;
  if (config.search.enabled) {
    const auth = new CodexAuth(config.search.authFile);
    search = new CodexWebSearch(auth);
    await auth.get().catch((error: Error) => logger.warn(`联网搜索暂不可用：${error.message}`));
  }

  let stickers: StickerStore | undefined;
  if (config.stickers.enabled) {
    stickers = new StickerStore(config.stickers.dir, describeSticker(describeImage));
    await stickers.load();
  }

  const images = config.images.enabled ? new ImageDescriber(describeImageWith(describeImage)) : undefined;

  let memory: MemoryStore | undefined;
  if (config.memory.enabled) {
    memory = new MemoryStore(config.memory.file, completeJson);
    await memory.load();
  }

  const groups = [...config.bot.groups].join(",") || "（无）";
  const privateUsers = [...config.bot.privateUsers].join(",") || "（无）";
  logger.info(
    `bot=${config.bot.name} model=${DEEPSEEK_MODEL} jev=${judge ? config.jev.model : "off"} search=${search ? "on" : "off"} stickers=${stickers ? stickers.size : "off"} memory=${memory ? memory.size : "off"} groups=${groups} private=${privateUsers}`,
  );

  let runtime: ChatRuntime | undefined;
  const client = new NapcatClient((event) => {
    if (isMessageEvent(event)) runtime?.handle(event);
  });
  runtime = new ChatRuntime({ client, judge, search, stickers, images, memory });
  client.connect();

  const shutdown = async () => {
    logger.info("退出中…");
    await stickers?.flush().catch(() => undefined);
    await memory?.flush().catch(() => undefined);
    await client.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
