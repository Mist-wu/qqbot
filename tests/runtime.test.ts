import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "500";
process.env.BOT_PRIVATE_USERS = "42";
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GATE_DIRECT_DEBOUNCE_MS = "10";
process.env.GATE_GROUP_DEBOUNCE_MS = "30";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
process.env.LOG_LEVEL = "silent";
process.env.MEMORY_LEARN_DELAY_MS = "50";
process.env.REPLY_FORWARD_PARTS = "3";

const { ChatRuntime } = await import("../src/chat/runtime.js");
const { MemoryStore } = await import("../src/chat/memory.js");
type Deps = ConstructorParameters<typeof ChatRuntime>[0];

const SELF = 100;
let nextId = 1000;
let forwardFails = false;

function groupMessage(text: string, extra: Record<string, unknown>[] = [], groupId = 500, userId = 7) {
  return {
    post_type: "message" as const,
    message_type: "group" as const,
    message_id: nextId++,
    user_id: userId,
    group_id: groupId,
    self_id: SELF,
    time: Math.floor(Date.now() / 1000),
    message: [...extra, { type: "text", data: { text } }] as { type: string; data: Record<string, unknown> }[],
    sender: { user_id: userId, nickname: "张三", card: "" },
  };
}

function setup(judge: Deps["judge"], replies: string[], memory?: Deps["memory"], search?: Deps["search"]) {
  const sent: { target: unknown; message: unknown[] }[] = [];
  const prompts: string[] = [];
  const systems: string[] = [];
  const actions: string[] = [];
  const tools: unknown[] = [];
  const forwards: { target: unknown; nodes: unknown[] }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    tools.push(body.tools);
    systems.push(body.messages[0].content);
    prompts.push(body.messages.at(-1).content);
    return new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() ?? "" } }] }), { status: 200 });
  }) as typeof fetch;
  const client = {
    selfId: SELF,
    sendMessage: async (target: unknown, message: unknown[]) => {
      sent.push({ target, message });
      return nextId++;
    },
    sendForward: async (target: unknown, nodes: unknown[]) => {
      if (forwardFails) throw new Error("forward unsupported");
      forwards.push({ target, nodes });
      return nextId++;
    },
    callAction: async (action: string, params: { user_id?: number }) => {
      actions.push(action);
      if (action === "get_msg") {
        return {
          status: "ok" as const,
          retcode: 0,
          data: { user_id: 8, sender: { card: "王五" }, message: [{ type: "text", data: { text: "GitHub Trending 今日榜单" } }] },
        };
      }
      if (action === "get_group_member_info") {
        return { status: "ok" as const, retcode: 0, data: params.user_id === 777 ? { card: "路人甲" } : {} };
      }
      return { status: "ok" as const, retcode: 0, data: { group_name: "测试群" } };
    },
  } as unknown as Deps["client"];
  return { runtime: new ChatRuntime({ client, judge, search, stickers: undefined, memory }), sent, prompts, systems, actions, tools, forwards };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("@bot with a modest jev score gets a reply", async () => {
  const { runtime, sent, prompts } = setup(async () => ({ should_reply: 0.4, addressed: 1 }), ["在的\n咋了"]);
  runtime.handle(groupMessage("在吗", [{ type: "at", data: { qq: String(SELF) } }]));
  await wait(1200);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]!.target, { groupId: 500 });
  assert.deepEqual(sent[0]!.message, [{ type: "text", data: { text: "在的" } }]);
  assert.match(prompts[0]!, /★\[\d\d:\d\d\] 张三（@你）：@小猫 在吗/);
});

test("burst of messages is judged once and quoted when others kept talking", async () => {
  const batches: number[] = [];
  let resolveReply: (() => void) | undefined;
  const { runtime, sent } = setup(async (state) => {
    batches.push((state as { new_messages: unknown[] }).new_messages.length);
    return { should_reply: batches.length === 1 ? 0.9 : 0.1, addressed: 0.5 };
  }, ["我也觉得"]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    await new Promise<void>((resolve) => {
      resolveReply = resolve;
    });
    return origFetch(...args);
  }) as typeof fetch;

  runtime.handle(groupMessage("今天好热"));
  runtime.handle(groupMessage("是啊"));
  await wait(100);
  runtime.handle(groupMessage("别的话题", [], 500, 8));
  resolveReply?.();
  await wait(200);

  // The two-message burst is judged together; the message that arrived mid-reply gets its own round.
  assert.deepEqual(batches, [2, 1]);
  assert.equal(sent.length, 1);
  const segments = sent[0]!.message as { type: string }[];
  assert.equal(segments[0]!.type, "reply");
});

test("@bot with a bare reaction is left alone when jev says no", async () => {
  const { runtime, sent } = setup(async () => ({ should_reply: 0.1, addressed: 0.8 }), ["不该发"]);
  runtime.handle(groupMessage("哈哈哈", [{ type: "at", data: { qq: String(SELF) } }]));
  await wait(100);
  assert.equal(sent.length, 0);
});

test("ignores disabled groups and the bot's own messages", async () => {
  let judged = 0;
  const { runtime, sent } = setup(async () => {
    judged++;
    return { should_reply: 1 };
  }, ["x"]);
  runtime.handle(groupMessage("hi", [], 999));
  runtime.handle(groupMessage("hi", [], 500, SELF));
  await wait(100);
  assert.equal(judged, 0);
  assert.equal(sent.length, 0);
});

test("model can decline with the skip marker", async () => {
  const { runtime, sent } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["[不回复]"]);
  runtime.handle(groupMessage("hello"));
  await wait(150);
  assert.equal(sent.length, 0);
});

test("stickers are described before jev sees them and can be sent back", async () => {
  const described: string[] = [];
  const store = {
    observe: async () => {
      await wait(20);
      return "猫猫叹气";
    },
    list: () => [{ id: 3, description: "猫猫叹气" }],
    byId: (id: number) => (id === 3 ? { id: 3, description: "猫猫叹气" } : undefined),
    toSegment: async () => ({ type: "image", data: { file: "base64://R0lG", sub_type: 1 } }),
  };
  const { runtime, sent, prompts } = setup(async (state) => {
    described.push((state as { new_messages: { text: string }[] }).new_messages[0]!.text);
    return { should_reply: 0.9, addressed: 0.2 };
  }, ["确实\n[表情包#3]\n[表情包#99]"]);
  (runtime as unknown as { deps: { stickers: unknown } }).deps.stickers = store;

  runtime.handle(groupMessage("", [{ type: "image", data: { file: "a.gif", url: "https://x/a.gif", sub_type: 1 } }]));
  await wait(2500);

  assert.deepEqual(described, ["[表情包：猫猫叹气]"]);
  assert.match(prompts[0]!, /张三：\[表情包：猫猫叹气\]/);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.message, [{ type: "image", data: { file: "base64://R0lG", sub_type: 1 } }]);
});

test("private chat only answers whitelisted users", async () => {
  const judged: number[] = [];
  const { runtime, sent } = setup(async (state) => {
    judged.push(1);
    return { should_reply: 0.9, addressed: 0.9 };
  }, ["在"]);
  const privateMessage = (userId: number) => ({
    ...groupMessage("在吗", [], 0, userId),
    message_type: "private" as const,
    group_id: undefined,
  });
  runtime.handle(privateMessage(43));
  runtime.handle(privateMessage(42));
  await wait(1700);
  assert.equal(judged.length, 1);
  assert.deepEqual(sent.map((item) => item.target), [{ userId: 42 }]);
});

test("face names in a reply are sent as real faces within the same message", async () => {
  const { runtime, sent } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["不至于吧[doge]"]);
  runtime.handle(groupMessage("在吗", [{ type: "at", data: { qq: String(SELF) } }]));
  await wait(200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.message, [
    { type: "text", data: { text: "不至于吧" } },
    { type: "face", data: { id: "179" } },
  ]);
});

test("what was said in private is remembered in the group", async () => {
  const learned: string[] = [];
  const memory = new MemoryStore(join(tmpdir(), `qqbot-mem-${process.pid}.json`), async (_system, user) => {
    learned.push(user);
    return { people: [{ user_id: 42, facts: ["在北京工作"] }] };
  });
  const { runtime, systems } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["好嘞", "北京打工人来了"], memory);
  runtime.handle({ ...groupMessage("我在北京上班", [], 0, 42), message_type: "private" as const, group_id: undefined });
  await wait(1800);
  assert.equal(learned.length, 1);
  assert.match(learned[0]!, /和「张三」的QQ私聊/);

  runtime.handle(groupMessage("有人吗", [{ type: "at", data: { qq: String(SELF) } }], 500, 42));
  await wait(200);
  assert.match(systems.at(-1)!, /- 张三：私聊里告诉你的：在北京工作/);
});

test("@ names are looked up once and shown to jev and the model", async () => {
  const seen: string[] = [];
  const { runtime, prompts, actions } = setup(async (state) => {
    seen.push((state as { new_messages: { text: string }[] }).new_messages.map((m) => m.text).join(" | "));
    return { should_reply: 0.9, addressed: 0.9 };
  }, ["记得啊", "嗯"]);
  const at = (qq: number) => ({ type: "at", data: { qq: String(qq) } });
  runtime.handle(groupMessage("吗", [at(SELF), { type: "text", data: { text: "你还记得" } }, at(777)], 500, 9));
  await wait(200);
  runtime.handle(groupMessage("呢", [at(SELF), at(777), at(9)], 500, 7));
  await wait(200);

  assert.equal(seen[0], "@小猫 你还记得@路人甲 吗");
  assert.equal(seen[1], "@小猫 @路人甲 @张三 呢");
  assert.doesNotMatch(prompts.join("\n"), /777/);
  assert.equal(actions.filter((action) => action === "get_group_member_info").length, 1);
});

test("web_search is offered when jev scores it above 0.1 and the token is usable", async () => {
  let usable = true;
  const scores = [0.31, 0.05, 0.9];
  const search = { usable: async () => usable, search: async () => "" } as unknown as Deps["search"];
  const { runtime, tools } = setup(
    async () => ({ should_reply: 0.9, addressed: 0.9, needs_search: scores.shift()! }),
    ["a", "b", "c"],
    undefined,
    search,
  );
  const at = { type: "at", data: { qq: String(SELF) } };
  runtime.handle(groupMessage("你自己去搜一下jev", [at]));
  await wait(200);
  runtime.handle(groupMessage("哈哈", [at]));
  await wait(200);
  usable = false;
  runtime.handle(groupMessage("今天比分多少", [at]));
  await wait(200);
  assert.equal((tools[0] as { function: { name: string } }[])[0]!.function.name, "web_search");
  assert.equal(tools[1], undefined);
  assert.equal(tools[2], undefined);
});

test("long replies are sent as one merged forward, with a plain fallback", async () => {
  const at = { type: "at", data: { qq: String(SELF) } };
  const long = "展开讲讲👇\n第一点\n第二点\n第三点\n第四点";
  const { runtime, sent, forwards } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), [long, long]);
  runtime.handle(groupMessage("详细说说", [at]));
  await wait(2500);
  assert.deepEqual(sent.map((item) => item.message), [[{ type: "text", data: { text: "展开讲讲👇" } }]]);
  assert.equal(forwards.length, 1);
  const node = (forwards[0]!.nodes as { type: string; data: { nickname: string; content: unknown } }[])[0]!;
  assert.equal(node.type, "node");
  assert.equal(node.data.nickname, "小猫");
  assert.deepEqual(node.data.content, [{ type: "text", data: { text: "第一点\n第二点\n第三点\n第四点" } }]);

  forwardFails = true;
  runtime.handle(groupMessage("再说一次", [at]));
  await wait(9000);
  forwardFails = false;
  assert.equal(sent.length, 1 + 1 + 4);
});

test("pictures are described before jev sees them", async () => {
  const seen: string[] = [];
  const { runtime } = setup(async (state) => {
    seen.push((state as { new_messages: { text: string }[] }).new_messages[0]!.text);
    return { should_reply: 0.1, addressed: 0.1 };
  }, []);
  const images = { observe: async () => "手机设置页面的截图" };
  (runtime as unknown as { deps: { images: unknown } }).deps.images = images;
  runtime.handle(groupMessage("你看图片了吗", [{ type: "image", data: { file: "p.png", url: "https://x/p.png", sub_type: 0 } }]));
  await wait(300);
  assert.deepEqual(seen, ["[图片：手机设置页面的截图]你看图片了吗"]);
});

test("@名字 in a reply becomes a real mention of a known member", async () => {
  const { runtime, sent } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["@张三 你问的是这个？"]);
  runtime.handle(groupMessage("在吗", [{ type: "at", data: { qq: String(SELF) } }], 500, 7));
  await wait(200);
  assert.deepEqual(sent.at(-1)!.message.slice(0, 2), [
    { type: "at", data: { qq: "7" } },
    { type: "text", data: { text: " " } },
  ]);
});

test("quoted messages are shown, from history or fetched via get_msg", async () => {
  const seen: string[] = [];
  const { runtime, actions } = setup(async (state) => {
    seen.push((state as { new_messages: { text: string }[] }).new_messages.map((m) => m.text).join(" | "));
    return { should_reply: 0.1, addressed: 0.1 };
  }, []);
  const first = groupMessage("今晚吃火锅");
  runtime.handle(first);
  await wait(100);
  runtime.handle(groupMessage("同意", [{ type: "reply", data: { id: String(first.message_id) } }], 500, 8));
  await wait(100);
  runtime.handle(groupMessage("这些都是干什么的", [{ type: "reply", data: { id: "999999" } }]));
  await wait(100);
  assert.equal(seen[1], "[回复 张三：今晚吃火锅] 同意");
  assert.equal(seen[2], "[回复 王五：GitHub Trending 今日榜单] 这些都是干什么的");
  assert.equal(actions.filter((action) => action === "get_msg").length, 1);
});
