import { config } from "./config.js";
import { createJevJudge } from "./chat/gate.js";
import { ChatRuntime } from "./chat/runtime.js";
import { ImageDescriber } from "./chat/images.js";
import { MediaCache } from "./chat/media-cache.js";
import { MemoryStore } from "./chat/memory.js";
import { PowerSwitch } from "./chat/power.js";
import { StickerStore } from "./chat/stickers.js";
import { VoiceTranscriber } from "./chat/voices.js";
import { DEEPSEEK_MODEL, completeJson, describeImage, speak, transcribe } from "./llm/deepseek.js";
import { logger } from "./logger.js";
import { NapcatClient } from "./napcat/client.js";
import { isMessageEvent } from "./napcat/types.js";

async function main(): Promise<void> {
  if (!config.deepseek.apiKey) {
    logger.error("缺少 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  const judge = config.jev.apiKey ? createJevJudge() : undefined;
  if (!judge) logger.warn("未设置 TYPESAFE_API_KEY：jev 不可用，只在私聊、@、回复、点名时发言");

  const mediaCache = new MediaCache();
  let stickers: StickerStore | undefined;
  if (config.stickers.enabled) {
    stickers = new StickerStore(config.stickers.dir, describeImage);
    await stickers.load();
  }

  const images = config.images.enabled ? new ImageDescriber(describeImage, mediaCache) : undefined;

  let memory: MemoryStore | undefined;
  if (config.memory.enabled) {
    memory = new MemoryStore(config.memory.file, completeJson);
    await memory.load();
  }

  const power = new PowerSwitch(config.bot.stateFile);
  await power.load();

  const groups = [...config.bot.groups].join(",") || "（无）";
  const privateUsers = [...config.bot.privateUsers].join(",") || "（无）";
  logger.info(
    `bot=${config.bot.name} model=${DEEPSEEK_MODEL} jev=${judge ? config.jev.model : "off"} search=${config.search.enabled ? "on" : "off"} links=${config.search.readLinks ? "on" : "off"} voices=${config.voices.enabled ? "on" : "off"} tts=${config.tts.enabled ? config.tts.voice : "off"} stickers=${stickers ? stickers.size : "off"} memory=${memory ? memory.size : "off"} groups=${groups} private=${privateUsers} admins=${[...config.bot.adminUsers].join(",") || "（无）"} power=${power.on ? "on" : "off"}`,
  );

  let runtime: ChatRuntime | undefined;
  const client = new NapcatClient((event) => {
    if (isMessageEvent(event)) runtime?.handle(event);
  });
  const voices = config.voices.enabled ? new VoiceTranscriber(client, transcribe, mediaCache) : undefined;
  runtime = new ChatRuntime({
    client,
    judge,
    stickers,
    images,
    voices,
    speak: config.tts.enabled ? speak : undefined,
    memory,
    power,
  });
  client.connect();

  let exiting = false;
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    logger.info("退出中…");
    await client.shutdown();
    await stickers?.flush().catch((error: unknown) => logger.warn("[sticker] 退出保存失败:", (error as Error).message));
    await memory?.flush().catch((error: unknown) => logger.warn("[memory] 退出保存失败:", (error as Error).message));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
