import { config } from "../config.js";
import { logger } from "../logger.js";

export const DEEPSEEK_MODEL = "deepseek-flash";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export type Tool = { definition: ToolDefinition; handler: ToolHandler };

type CompletionResponse = {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
};

async function complete(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens = config.deepseek.maxTokens,
  json = false,
): Promise<CompletionResponse> {
  const body: Record<string, unknown> = {
    model: DEEPSEEK_MODEL,
    messages,
    max_tokens: maxTokens,
    thinking: { type: config.deepseek.thinking ? "enabled" : "disabled" },
    stream: false,
  };
  if (tools.length > 0) body.tools = tools;
  if (json) body.response_format = { type: "json_object" };

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

// Runs the tool loop until the model answers in text. With tools attached, DeepSeek requires every
// earlier assistant turn's reasoning_content to be sent back, so assistant messages keep it verbatim.
export async function chatWithTools(initial: ChatMessage[], tools: Tool[]): Promise<string> {
  const messages = [...initial];
  const byName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));

  for (let round = 0; ; round++) {
    const offerTools = round < config.deepseek.maxToolRounds ? tools.map((tool) => tool.definition) : [];
    const result = await complete(messages, offerTools);
    const message = result.choices?.[0]?.message;
    if (!message) throw new Error("DeepSeek 返回为空");
    logger.debug(
      `[deepseek] round=${round} finish=${result.choices?.[0]?.finish_reason} usage=${JSON.stringify(result.usage)}`,
    );

    const calls = message.tool_calls ?? [];
    const assistant: ChatMessage = { role: "assistant", content: message.content ?? "" };
    if (message.reasoning_content) assistant.reasoning_content = message.reasoning_content;
    if (calls.length === 0) return message.content?.trim() ?? "";

    assistant.tool_calls = calls;
    messages.push(assistant);
    const results = await Promise.all(calls.map((call) => runTool(byName, call)));
    calls.forEach((call, index) => messages.push({ role: "tool", tool_call_id: call.id, content: results[index]! }));
  }
}

// JSON mode; the prompt itself must mention JSON.
export async function completeJson(system: string, user: string, maxTokens = 2000): Promise<unknown> {
  const result = await complete(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    [],
    maxTokens,
    true,
  );
  return JSON.parse(result.choices?.[0]?.message?.content ?? "");
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
    200,
  );
  return result.choices?.[0]?.message?.content?.trim() ?? "";
}

async function runTool(byName: Map<string, Tool>, call: ToolCall): Promise<string> {
  const tool = byName.get(call.function.name);
  if (!tool) return `未知工具: ${call.function.name}`;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return "工具参数不是合法 JSON";
  }
  try {
    logger.info(`[tool] ${call.function.name} ${JSON.stringify(args)}`);
    return await tool.handler(args);
  } catch (error) {
    logger.warn(`[tool] ${call.function.name} 失败:`, (error as Error).message);
    return `工具调用失败: ${(error as Error).message}`;
  }
}
