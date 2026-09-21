import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import type { CodexAuth } from "./codex-auth.js";

// Internal alpha endpoint from Codex source (codex-rs/codex-api/src/endpoint/search.rs); see
// pi-extensions/websearch for the same integration.
const SEARCH_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
const MAX_RETRIES = 2;
const MAX_OUTPUT_CHARS = 8000;

export type WebSearchRequest = {
  query: string;
  recencyDays?: number;
  // The chat question the search serves; Codex uses it to focus results.
  question?: string;
};

// Codex emits citation markers such as "\ue200cite\ue202turn0search0\ue201" meant for its own UI.
export function cleanSearchOutput(output: string, maxChars = MAX_OUTPUT_CHARS): string {
  const cleaned = output
    .replace(/[\ue200-\ue2ff]?cite[\ue200-\ue2ff]?(?:turn\d+[a-z]+\d+[\ue200-\ue2ff]?)+/g, "")
    .replace(/[\ue200-\ue2ff]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}\n…(结果已截断)` : cleaned;
}

export class CodexWebSearch {
  constructor(private readonly auth: CodexAuth) {}

  // Whether a synced, unexpired access token is on disk right now.
  usable(): Promise<boolean> {
    return this.auth.usable();
  }

  async search(request: WebSearchRequest): Promise<string> {
    const credential = await this.auth.get();
    const query: Record<string, unknown> = { q: request.query };
    if (request.recencyDays && request.recencyDays > 0) query.recency = Math.floor(request.recencyDays);

    const body: Record<string, unknown> = {
      id: randomUUID(),
      model: config.search.model,
      commands: { search_query: [query], response_length: "medium" },
      settings: {
        search_context_size: config.search.contextSize,
        allowed_callers: ["direct"],
        external_web_access: true,
      },
      max_output_tokens: config.search.maxOutputTokens,
    };
    if (request.question) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: request.question }] }];
    }

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.access}`,
            "chatgpt-account-id": credential.accountId,
            "content-type": "application/json",
            originator: "qqbot",
            "user-agent": "qqbot/0.1",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.search.timeoutMs),
        });
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new Error(`Codex 搜索网络错误: ${(error as Error).message}`);
      }

      if (response.ok) {
        const payload = (await response.json()) as { output?: unknown };
        if (typeof payload.output !== "string") throw new Error("Codex 搜索没有返回文本结果");
        return cleanSearchOutput(payload.output);
      }
      if (attempt < MAX_RETRIES && (response.status === 429 || response.status >= 500)) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const text = (await response.text().catch(() => "")).replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
      throw new Error(`Codex 搜索失败 (${response.status}): ${text.slice(0, 500)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
