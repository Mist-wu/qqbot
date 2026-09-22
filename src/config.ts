import dotenv from "dotenv";

// node --test marks its child processes; tests must not pick up a developer's local .env.
if (!process.env.NODE_TEST_CONTEXT) dotenv.config();

function str(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function idSet(name: string): Set<number> {
  return new Set(list(name).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
}

const DEFAULT_PERSONA = "是群里的一个 AI 群友。";

export const config = {
  logLevel: str("LOG_LEVEL", "info"),
  napcat: {
    url: str("NAPCAT_WS_URL", "ws://127.0.0.1:3001"),
    token: str("NAPCAT_TOKEN"),
    reconnectMs: num("NAPCAT_RECONNECT_MS", 3000),
    heartbeatTimeoutMs: num("NAPCAT_HEARTBEAT_TIMEOUT_MS", 30000),
    actionTimeoutMs: num("NAPCAT_ACTION_TIMEOUT_MS", 15000),
    sendIntervalMs: num("NAPCAT_SEND_INTERVAL_MS", 800),
  },
  bot: {
    name: str("BOT_NAME", "小猫"),
    aliases: list("BOT_ALIASES"),
    persona: str("BOT_PERSONA", DEFAULT_PERSONA),
    groups: idSet("BOT_GROUPS"),
    privateUsers: idSet("BOT_PRIVATE_USERS"),
  },
  gate: {
    groupThreshold: num("GATE_GROUP_THRESHOLD", 0.6),
    privateThreshold: num("GATE_PRIVATE_THRESHOLD", 0.35),
    directThreshold: num("GATE_DIRECT_THRESHOLD", 0.3),
    groupDebounceMs: num("GATE_GROUP_DEBOUNCE_MS", 3000),
    privateDebounceMs: num("GATE_PRIVATE_DEBOUNCE_MS", 1500),
    directDebounceMs: num("GATE_DIRECT_DEBOUNCE_MS", 800),
    maxWaitMs: num("GATE_MAX_WAIT_MS", 10000),
    presenceWindowMs: num("GATE_PRESENCE_WINDOW_MS", 5 * 60 * 1000),
    // Offer web_search when jev's needs_search score is above this.
    searchThreshold: num("GATE_SEARCH_THRESHOLD", 0.1),
  },
  jev: {
    apiKey: str("TYPESAFE_API_KEY"),
    model: str("JEV_MODEL", "jev-latest"),
    timeoutMs: num("JEV_TIMEOUT_MS", 5000),
  },
  deepseek: {
    apiKey: str("DEEPSEEK_API_KEY"),
    baseUrl: str("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    thinking: bool("DEEPSEEK_THINKING", false),
    timeoutMs: num("DEEPSEEK_TIMEOUT_MS", 60000),
    maxTokens: num("DEEPSEEK_MAX_TOKENS", 800),
    // Only used for replies; 1.3 produced stray foreign punctuation and words.
    temperature: num("DEEPSEEK_TEMPERATURE", 1.1),
    maxToolRounds: num("DEEPSEEK_MAX_TOOL_ROUNDS", 3),
  },
  search: {
    enabled: bool("SEARCH_ENABLED", true),
    authFile: str("CODEX_AUTH_FILE", "data/codex-auth.json"),
    model: str("CODEX_SEARCH_MODEL", "gpt-5.6-luna"),
    contextSize: str("CODEX_SEARCH_CONTEXT_SIZE", "medium"),
    maxOutputTokens: num("CODEX_SEARCH_MAX_OUTPUT_TOKENS", 3000),
    timeoutMs: num("CODEX_SEARCH_TIMEOUT_MS", 60000),
  },
  stickers: {
    enabled: bool("STICKERS_ENABLED", true),
    dir: str("STICKERS_DIR", "data/stickers"),
    max: num("STICKERS_MAX", 300),
    promptLimit: num("STICKERS_PROMPT_LIMIT", 40),
  },
  images: {
    enabled: bool("IMAGES_ENABLED", true),
    maxBytes: num("IMAGES_MAX_BYTES", 8 * 1024 * 1024),
  },
  memory: {
    enabled: bool("MEMORY_ENABLED", true),
    file: str("MEMORY_FILE", "data/memory.json"),
    // Learn this long after the bot replied, or right away once this many messages are unlearned.
    learnDelayMs: num("MEMORY_LEARN_DELAY_MS", 10000),
    learnBatch: num("MEMORY_LEARN_BATCH", 30),
    // Batch learning (without a reply) only if the bot spoke in the session within this window.
    engagedWindowMs: num("MEMORY_ENGAGED_WINDOW_MS", 30 * 60 * 1000),
    maxFacts: num("MEMORY_MAX_FACTS", 20),
  },
  history: {
    maxMessages: num("HISTORY_MAX_MESSAGES", 60),
    contextMessages: num("HISTORY_CONTEXT_MESSAGES", 20),
  },
  reply: {
    // A reply longer than this is sent as one merged-forward message instead of a burst of lines.
    forwardParts: num("REPLY_FORWARD_PARTS", 5),
    forwardChars: num("REPLY_FORWARD_CHARS", 300),
    // Safety caps against runaway output only; the prompt leaves length to the model.
    maxChars: num("REPLY_MAX_CHARS", 1500),
    maxParts: num("REPLY_MAX_PARTS", 40),
  },
};

export type Config = typeof config;
