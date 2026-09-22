import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.LOG_LEVEL = "silent";
process.env.MEMORY_MAX_FACTS = "3";

const { MemoryStore } = await import("../src/chat/memory.js");
const { SessionHistory } = await import("../src/chat/history.js");
type ChatRecord = Parameters<InstanceType<typeof MemoryStore>["describe"]>[0][number];

function record(userId: number, name: string, text: string, fromBot = false): ChatRecord {
  return { userId, name, text, time: Date.UTC(2026, 8, 21, 11, 0), fromBot, atBot: false, replyToBot: false, mentionsBot: false };
}

async function store(answer: unknown, prompts: string[] = []) {
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-memory-")), "memory.json");
  const memory = new MemoryStore(file, async (system, user) => {
    prompts.push(`${system}\n${user}`);
    return answer;
  });
  return { file, memory };
}

test("private facts are learned only for real speakers and labeled in other chats", async () => {
  const prompts: string[] = [];
  const { memory } = await store(
    { people: [{ user_id: 42, facts: ["在北京工作", "喜欢猫", "喜欢猫", " "] }, { user_id: 999, facts: ["编的"] }] },
    prompts,
  );
  const chat = [record(42, "李四", "我在北京上班，家里有只猫"), record(1, "OvO", "猫叫啥", true)];
  assert.equal(await memory.learn("private", "李四", chat, "OvO"), 1);
  assert.equal(memory.get(999), undefined);
  assert.deepEqual(memory.get(42)!.private, ["在北京工作", "喜欢猫"]);
  assert.match(prompts[0]!, /李四（QQ 42）：我在北京上班/);
  assert.match(prompts[0]!, /OvO（你）：猫叫啥/);
  assert.doesNotMatch(prompts[0]!, /QQ 1）/);

  const group = [record(7, "张三", "晚上吃啥"), record(42, "李四", "随便")];
  assert.deepEqual(memory.describe(group), ["李四：私聊里告诉你的：在北京工作；喜欢猫"]);
});

test("group facts sit beside private ones, capped per scope", async () => {
  const { memory } = await store({ people: [{ user_id: 42, facts: ["a", "b", "c", "d"] }] });
  await memory.learn("group", "Bot测试", [record(42, "李四", "x")], "OvO");
  const { memory: other } = await store({ people: [{ user_id: 42, facts: ["私密"] }] });
  await other.learn("private", "李四", [record(42, "李四", "y")], "OvO");
  assert.deepEqual(memory.get(42)!.group, ["a", "b", "c"]);
  assert.deepEqual(memory.describe([record(42, "李四", "z")]), ["李四：a；b；c"]);
});

test("existing memories are shown to the extractor for merging", async () => {
  const prompts: string[] = [];
  const { memory } = await store({ people: [{ user_id: 42, facts: ["喜欢猫"] }] }, prompts);
  await memory.learn("private", "p", [record(42, "李四", "我养猫")], "OvO");
  await memory.learn("private", "p", [record(42, "李四", "猫丢了")], "OvO");
  assert.match(prompts[1]!, /李四（QQ 42）：喜欢猫/);
});

test("malformed extractor output changes nothing", async () => {
  for (const answer of [null, "oops", { people: "x" }, { people: [{ user_id: 42, facts: "x" }] }]) {
    const { memory } = await store(answer);
    assert.equal(await memory.learn("private", "p", [record(42, "a", "b")], "OvO"), 0);
    assert.equal(memory.size, 0);
  }
});

test("memories persist privately across restarts", async () => {
  const { file, memory } = await store({ people: [{ user_id: 42, facts: ["喜欢猫"] }] });
  await memory.learn("private", "p", [record(42, "李四", "我养猫")], "OvO");
  await memory.flush();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const reloaded = new MemoryStore(file, async () => ({}));
  await reloaded.load();
  assert.deepEqual(reloaded.get(42)!.private, ["喜欢猫"]);
});

test("history marks survive trimming", () => {
  const history = new SessionHistory(3);
  for (const text of ["1", "2", "3", "4"]) history.add(record(1, "a", text));
  assert.deepEqual(history.since(2).map((r) => r.text), ["3", "4"]);
  assert.deepEqual(history.since(0).map((r) => r.text), ["2", "3", "4"]);
  assert.deepEqual(history.since(4), []);
});

test("people @-mentioned are described too", async () => {
  const { memory } = await store({ people: [{ user_id: 77, facts: ["是群主"] }] });
  await memory.learn("group", "测试群", [record(77, "路人甲", "我是群主")], "OvO");
  const asked = { ...record(42, "王五", "@OvO 你还记得@路人甲 吗"), mentions: [77] };
  assert.deepEqual(memory.describe([asked]), ["路人甲：是群主"]);
});

test("the extractor is asked for lasting facts and sees who talks to whom", async () => {
  const prompts: string[] = [];
  const { memory } = await store({ people: [] }, prompts);
  const quoted = { ...record(42, "李四", "我也是"), quote: { name: "OvO", text: "我喜欢猫", fromBot: true } };
  await memory.learn("group", "测试群", [record(1, "OvO", "我喜欢猫", true), quoted], "OvO");
  assert.match(prompts[0]!, /长期有效/);
  assert.match(prompts[0]!, /隐私/);
  assert.match(prompts[0]!, /李四（QQ 42） → OvO：我也是（引用OvO的「我喜欢猫」）/);
});
