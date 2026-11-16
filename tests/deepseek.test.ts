import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DEEPSEEK_API_KEY = "test-key";
process.env.LOG_LEVEL = "silent";

const { chat, completeJson, speak, transcribe, isCompleteWav, DEEPSEEK_MODEL } = await import("../src/llm/deepseek.js");

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

test("built-in tools are declared by type and the reply text is returned", async () => {
  const bodies = mockFetch([
    {
      choices: [
        {
          message: {
            content: "答案是42",
            server_tool_calls: [{ calls: [{ type: "deepseek_web_search", kind: "search", status: "completed" }] }],
          },
        },
      ],
    },
    { choices: [{ message: { content: " 好 " } }] },
  ]);
  assert.equal(await chat([{ role: "user", content: "问题" }], ["deepseek_web_search", "deepseek_read_url"]), "答案是42");
  assert.equal(bodies[0]!.model, DEEPSEEK_MODEL);
  assert.equal(bodies[0]!.model, "deepseek-flash");
  assert.equal(bodies[0]!.temperature, 1.1);
  assert.deepEqual(bodies[0]!.tools, [{ type: "deepseek_web_search" }, { type: "deepseek_read_url" }]);

  assert.equal(await chat([{ role: "user", content: "q" }]), "好");
  assert.equal(bodies[1]!.tools, undefined);
});

function wav(dataBytes: number): Buffer {
  const audio = Buffer.alloc(44 + dataBytes);
  audio.write("RIFF", 0, "ascii");
  audio.writeUInt32LE(36 + dataBytes, 4);
  audio.write("WAVE", 8, "ascii");
  return audio;
}

test("speech goes to the tools endpoints; truncated audio is a failure", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const replies = [
    new Response(JSON.stringify({ request_id: "r", text: " 你好 ", duration_ms: 900 }), { status: 200 }),
    new Response(new Uint8Array(wav(10)), { status: 200 }),
    new Response(new Uint8Array(wav(10).subarray(0, 50)), { status: 200 }),
    new Response("busy", { status: 503 }),
  ];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return replies.shift()!;
  }) as typeof fetch;

  assert.equal(await transcribe(Buffer.from("RIFF")), "你好");
  assert.equal(requests[0]!.url, "https://api.deepseek.com/v1/tools/asr");
  assert.ok((requests[0]!.init.body as FormData).get("file") instanceof Blob);

  assert.equal((await speak("晚安")).length, 54);
  assert.equal(requests[1]!.url, "https://api.deepseek.com/v1/tools/tts");
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), { text: "晚安", voice_id: "stella", format: "wav" });

  await assert.rejects(speak("晚安"), /中断/);
  await assert.rejects(speak("晚安"), /503/);
});

test("streamed WAV with an unknown size counts as complete", () => {
  const streamed = wav(4);
  streamed.writeUInt32LE(0xffffffff, 4);
  assert.equal(isCompleteWav(streamed), true);
  assert.equal(isCompleteWav(Buffer.from("nope")), false);
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
