import assert from "node:assert/strict";
import { test } from "node:test";

process.env.REPLY_MAX_PARTS = "3";
process.env.REPLY_MAX_CHARS = "20";
process.env.REPLY_FORWARD_PARTS = "2";
process.env.REPLY_FORWARD_CHARS = "30";

const { postProcess, buildTranscript, buildSystemPrompt, planSends, dropRepeatedEndings, hasLink, SKIP_MARKER } = await import(
  "../src/chat/reply.js"
);

const text = (value: string) => ({ kind: "text", text: value });

test("skip marker and empty output send nothing", () => {
  assert.deepEqual(postProcess(SKIP_MARKER, "小猫"), []);
  assert.deepEqual(postProcess("  ", "小猫"), []);
});

test("strips markdown and name prefix", () => {
  const raw = "小猫：**好的**\n- 第一点\n## 标题";
  assert.deepEqual(postProcess(raw, "小猫"), [text("好的"), text("- 第一点"), text("标题")]);
});

test("each line is a message; caps only guard against runaway output", () => {
  assert.deepEqual(postProcess("a\nb\nc\nd", "小猫"), [text("a"), text("b"), text("c")]);
  assert.deepEqual(postProcess("一".repeat(25), "小猫"), [text(`${"一".repeat(20)}…`)]);
});

test("sticker markers become sticker parts in order", () => {
  assert.deepEqual(postProcess("笑死[表情包#3]\n[表情包#12]", "小猫"), [
    text("笑死"),
    { kind: "sticker", id: 3 },
    { kind: "sticker", id: 12 },
  ]);
});

test("lines starting with the voice marker become voice parts", () => {
  assert.deepEqual(postProcess("好的\n[语音]晚安[表情包#3]\n[语音]  ", "小猫"), [text("好的"), { kind: "voice", text: "晚安" }]);
});

test("links in new messages or their quotes are detected", () => {
  const record = (value: string, quote?: string) => ({ text: value, quote: quote ? { name: "a", text: quote, fromBot: false } : undefined });
  assert.equal(hasLink([record("看看 https://example.com/a?b=1")]), true);
  assert.equal(hasLink([record("这说的啥", "https://x.y/z")]), true);
  assert.equal(hasLink([record("没有链接 example.com")]), false);
});

test("system prompt lists stickers without prescribing style", () => {
  const ctx = {
    scope: "group" as const,
    sessionLabel: "测试群",
    botName: "小猫",
    persona: "是群里的一员。",
    earlier: [],
    pending: [],
    stickers: [{ id: 3, description: "猫猫叹气" }],
    memories: ["李四：私聊里告诉你的：在北京工作"],
    now: Date.now(),
    search: true,
    readLinks: true,
    voice: true,
  };
  const prompt = buildSystemPrompt(ctx);
  assert.match(prompt, /#3 猫猫叹气/);
  assert.match(prompt, /联网搜索/);
  assert.match(prompt, /打开新消息里的链接/);
  assert.match(prompt, /\[语音\] 开头/);
  assert.match(prompt, /- 李四：私聊里告诉你的：在北京工作/);
  const plain = buildSystemPrompt({ ...ctx, stickers: [], memories: [], search: false, readLinks: false, voice: false });
  assert.doesNotMatch(plain, /表情包#|联网|链接|语音|记得/);
});

test("transcript stars pending messages and labels the bot", () => {
  const base = { messageId: 1, userId: 2, time: Date.UTC(2026, 8, 21, 11, 5), atBot: false, replyToBot: false };
  const bot = { ...base, name: "小猫", text: "在的", fromBot: true };
  const user = { ...base, name: "张三", text: "你好", fromBot: false, atBot: true };
  const transcript = buildTranscript({
    scope: "group",
    sessionLabel: "测试群",
    botName: "小猫",
    persona: "",
    earlier: [bot],
    pending: [user],
    stickers: [],
    memories: [],
    now: Date.now(),
    search: false,
    readLinks: false,
    voice: false,
  });
  assert.match(transcript, /\[19:05\] 小猫（你）：在的/);
  assert.match(transcript, /★\[19:05\] 张三 → 你：你好/);
});

test("short replies go line by line; long ones become one merged forward", () => {
  const t = (value: string) => ({ kind: "text" as const, text: value });
  const sticker = { kind: "sticker" as const, id: 3 };
  assert.deepEqual(planSends([t("在的"), sticker]), [
    { kind: "part", part: t("在的") },
    { kind: "part", part: sticker },
  ]);
  assert.deepEqual(planSends([t("展开讲讲👇"), t("第一点"), t("第二点"), sticker]), [
    { kind: "part", part: t("展开讲讲👇") },
    { kind: "forward", text: "第一点\n第二点" },
    { kind: "part", part: sticker },
  ]);
  const voice = { kind: "voice" as const, text: "晚安" };
  assert.deepEqual(planSends([t("展开讲讲👇"), t("第一点"), voice, t("第二点")]), [
    { kind: "part", part: t("展开讲讲👇") },
    { kind: "forward", text: "第一点\n第二点" },
    { kind: "part", part: voice },
  ]);
  const long = "很长".repeat(20);
  assert.deepEqual(planSends([t(long), t("尾巴")]), [{ kind: "forward", text: `${long}\n尾巴` }]);
});

test("an ending emoji or face used twice recently is dropped", () => {
  const t = (value: string) => ({ kind: "text" as const, text: value });
  const recent = ["查户口是吧😌", "在的", "熬夜是吧😌"];
  assert.deepEqual(dropRepeatedEndings([t("谁问你了😌"), t("行吧[doge]")], recent), [t("谁问你了"), t("行吧[doge]")]);
  assert.deepEqual(dropRepeatedEndings([t("好😌")], ["a😌"]), [t("好😌")]);
  assert.deepEqual(dropRepeatedEndings([t("一😂"), t("二😂"), t("三😂")], []), [t("一😂"), t("二😂"), t("三")]);
  assert.deepEqual(dropRepeatedEndings([t("😌")], ["a😌", "b😌"]), [t("😌")]);
  assert.deepEqual(dropRepeatedEndings([t("看[图片]")], ["x[图片]", "y[图片]"]), [t("看[图片]")]);
});
