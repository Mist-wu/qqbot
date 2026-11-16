import { config } from "../config.js";
import { logger } from "../logger.js";

export const DEEPSEEK_MODEL = "deepseek-flash";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string };

// DeepSeek's built-in tools, run server-side: web search, and reading links in the last user message.
export type ServerTool = "deepseek_web_search" | "deepseek_read_url";

type ServerToolStep = {
  calls?: Array<{ type?: string; kind?: string; status?: string; action?: Record<string, unknown> }>;
};

type CompletionResponse = {
  choices?: Array<{
    message?: { content?: string | null; server_tool_calls?: ServerToolStep[] };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    server_tool_use?: Record<string, number>;
  };
};

type CompleteOptions = { maxTokens?: number; json?: boolean; temperature?: number };

async function complete(
  messages: ChatMessage[],
  tools: ServerTool[],
  { maxTokens = config.deepseek.maxTokens, json = false, temperature }: CompleteOptions = {},
): Promise<CompletionResponse> {
  const body: Record<string, unknown> = {
    model: DEEPSEEK_MODEL,
    messages,
    max_tokens: maxTokens,
    thinking: { type: config.deepseek.thinking ? "enabled" : "disabled" },
    stream: false,
  };
  if (tools.length > 0) body.tools = tools.map((type) => ({ type }));
  if (json) body.response_format = { type: "json_object" };
  if (temperature !== undefined) body.temperature = temperature;

  const response = await fetch(`${config.deepseek.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.deepseek.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.deepseek.timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DeepSeek 请求失败 (${response.status}): ${text.slice(0, 500)}`);
  }
  return (await response.json()) as CompletionResponse;
}

// One reply; any built-in tools run on DeepSeek's side within this single request.
export async function chat(messages: ChatMessage[], tools: ServerTool[] = []): Promise<string> {
  const result = await complete(messages, tools, { temperature: config.deepseek.temperature });
  const choice = result.choices?.[0];
  if (!choice?.message) throw new Error("DeepSeek 返回为空");
  for (const step of choice.message.server_tool_calls ?? []) {
    for (const call of step.calls ?? []) logger.info(`[tool] ${call.kind ?? call.type} ${call.status} ${JSON.stringify(call.action)}`);
  }
  logger.debug(`[deepseek] finish=${choice.finish_reason} usage=${JSON.stringify(result.usage)}`);
  return choice.message.content?.trim() ?? "";
}

// JSON mode; the prompt itself must mention JSON. JSON mode occasionally emits malformed output,
// so one retry is made.
export async function completeJson(system: string, user: string, maxTokens = 2000): Promise<unknown> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  for (let attempt = 0; ; attempt++) {
    const result = await complete(messages, [], { maxTokens, json: true });
    try {
      return JSON.parse(result.choices?.[0]?.message?.content ?? "");
    } catch (error) {
      if (attempt >= 1) throw error;
      logger.debug("[deepseek] JSON 解析失败，重试");
    }
  }
}

// deepseek-flash accepts images in user messages only.
export async function describeImage(dataUrl: string, instruction: string): Promise<string> {
  const result = await complete(
    [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: instruction },
        ],
      },
    ],
    [],
    { maxTokens: 300 },
  );
  return result.choices?.[0]?.message?.content?.trim() ?? "";
}

function toolsUrl(path: string): string {
  return `${config.deepseek.baseUrl.replace(/\/+$/, "")}/v1/tools/${path}`;
}

async function failure(response: Response, what: string): Promise<Error> {
  const text = await response.text().catch(() => "");
  return new Error(`DeepSeek ${what} 失败 (${response.status}): ${text.slice(0, 300)}`);
}

// Speech to text; accepts 16-bit PCM WAV or Ogg Opus, up to 120 seconds.
export async function transcribe(audio: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), "voice.wav");
  const response = await fetch(toolsUrl("asr"), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.deepseek.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(config.deepseek.timeoutMs),
  });
  if (!response.ok) throw await failure(response, "语音识别");
  const payload = (await response.json()) as { text?: unknown };
  return typeof payload.text === "string" ? payload.text.trim() : "";
}

// Text to speech as WAV bytes. A body that ends early means synthesis failed midway.
export async function speak(text: string): Promise<Buffer> {
  const response = await fetch(toolsUrl("tts"), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.deepseek.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice_id: config.tts.voice, format: "wav" }),
    signal: AbortSignal.timeout(config.deepseek.timeoutMs),
  });
  if (!response.ok) throw await failure(response, "语音合成");
  const audio = Buffer.from(await response.arrayBuffer());
  if (!isCompleteWav(audio)) throw new Error("DeepSeek 语音合成中断");
  return audio;
}

// The RIFF header states the total size, so a truncated stream can be told apart.
export function isCompleteWav(audio: Buffer): boolean {
  if (audio.length < 44 || audio.subarray(0, 4).toString("ascii") !== "RIFF") return false;
  const declared = audio.readUInt32LE(4);
  return declared === 0xffffffff || declared === 0 || audio.length >= declared + 8;
}
