import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DEEPSEEK_API_KEY = "test-key";
process.env.DEEPSEEK_MAX_TOOL_ROUNDS = "2";

const { chatWithTools, completeJson, DEEPSEEK_MODEL } = await import("../src/llm/deepseek.js");

type Body = { model: string; messages: any[]; tools?: unknown[]; thinking: { type: string }; temperature?: number };

function mockFetch(responses: unknown[]): Body[] {
  const bodies: Body[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Body);
    const next = responses.shift();
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return bodies;
}

const searchTool = (log: string[]) => ({
  definition: {
    type: "function" as const,
    function: { name: "web_search", description: "search", parameters: { type: "object", properties: {} } },
  },
  handler: async (args: Record<string, unknown>) => {
    log.push(String(args.query));
    return "结果: 42";
  },
});

test("runs tools and passes reasoning_content back", async () => {
  const bodies = mockFetch([
    {
      choices: [
        {
          message: {
            content: "",
            reasoning_content: "需要查一下",
            tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"答案"}' } }],
          },
        },
      ],
    },
    { choices: [{ message: { content: "答案是42", reasoning_content: "查到了" } }] },
  ]);
  const log: string[] = [];
  const text = await chatWithTools([{ role: "user", content: "问题" }], [searchTool(log)]);

  assert.equal(text, "答案是42");
  assert.deepEqual(log, ["答案"]);
  assert.equal(bodies[0]!.model, DEEPSEEK_MODEL);
  assert.equal(bodies[0]!.model, "deepseek-flash");
  assert.equal(bodies[0]!.temperature, 1.1);
  const second = bodies[1]!.messages;
  assert.equal(second[1].role, "assistant");
  assert.equal(second[1].reasoning_content, "需要查一下");
  assert.equal(second[1].tool_calls[0].id, "c1");
  assert.deepEqual(second[2], { role: "tool", tool_call_id: "c1", content: "结果: 42" });
});

test("stops offering tools after the round limit", async () => {
  const call = {
    choices: [
      { message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: "web_search", arguments: "{}" } }] } },
    ],
  };
  const bodies = mockFetch([call, call, { choices: [{ message: { content: "好" } }] }]);
  const text = await chatWithTools([{ role: "user", content: "q" }], [searchTool([])]);
  assert.equal(text, "好");
  assert.equal(bodies.length, 3);
  assert.ok(bodies[0]!.tools && bodies[1]!.tools);
  assert.equal(bodies[2]!.tools, undefined);
});

test("bad tool arguments are reported to the model instead of throwing", async () => {
  const bodies = mockFetch([
    { choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "web_search", arguments: "{oops" } }] } }] },
    { choices: [{ message: { content: "ok" } }] },
  ]);
  assert.equal(await chatWithTools([{ role: "user", content: "q" }], [searchTool([])]), "ok");
  assert.equal(bodies[1]!.messages.at(-1).content, "工具参数不是合法 JSON");
});

test("JSON extraction retries once on malformed output and uses default temperature", async () => {
  const bodies = mockFetch([
    { choices: [{ message: { content: '{"people":[{"user_id":1 "facts":[]}]}' } }] },
    { choices: [{ message: { content: '{"people":[]}' } }] },
  ]);
  assert.deepEqual(await completeJson("sys json", "user"), { people: [] });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]!.temperature, undefined);

  mockFetch([{ choices: [{ message: { content: "{bad" } }] }, { choices: [{ message: { content: "{bad" } }] }]);
  await assert.rejects(completeJson("sys json", "user"));
});
