import assert from "node:assert/strict";
import { test } from "node:test";

process.env.REPLY_MAX_PARTS = "3";
process.env.REPLY_MAX_CHARS = "20";
process.env.REPLY_FORWARD_PARTS = "2";
process.env.REPLY_FORWARD_CHARS = "30";

const { postProcess, buildTranscript, buildSystemPrompt, planSends, dropRepeatedEndings, SKIP_MARKER } = await import(
  "../src/chat/reply.js"
);

const text = (value: string) => ({ kind: "text", text: value });
const { cleanSearchOutput } = await import("../src/search/web-search.js");

test("skip marker and empty output send nothing", () => {
  assert.deepEqual(postProcess(SKIP_MARKER, "小猫"), []);
  assert.deepEqual(postProcess("  ", "小猫"), []);
});

test("strips markdown, name prefix and citation markers", () => {
  const raw = "小猫：**好的**\n- 第一点\ue200cite\ue202turn0search0\ue201\n## 标题";
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

test("system prompt lists stickers without prescribing style", () => {
  const ctx = {
    scope: "group" as const,
    sessionLabel: "测试群",
    botName: "小猫",
    persona: "是群里的一员。",
    records: [],
    pending: new Set<never>(),
    stickers: [{ id: 3, description: "猫猫叹气" }],
    memories: ["李四：私聊里告诉你的：在北京工作"],
    now: Date.now(),
  };
  const prompt = buildSystemPrompt(ctx, true);
  assert.match(prompt, /#3 猫猫叹气/);
  assert.match(prompt, /web_search/);
  assert.match(prompt, /- 李四：私聊里告诉你的：在北京工作/);
  assert.doesNotMatch(buildSystemPrompt({ ...ctx, stickers: [], memories: [] }, false), /表情包#|web_search|记得/);
});

test("search output loses Codex citation markers", () => {
  const raw = "Title (https://x.y)\n\ue200cite\ue202turn0search0\ue202turn0search1\ue201 body\n\n\n\nend";
  assert.equal(cleanSearchOutput(raw), "Title (https://x.y)\n body\n\nend");
  assert.ok(cleanSearchOutput("x".repeat(20), 10).startsWith("xxxxxxxxxx\n…"));
});

test("transcript stars pending messages and labels the bot", () => {
  const base = { messageId: 1, userId: 2, time: Date.UTC(2026, 8, 21, 11, 5), atBot: false, replyToBot: false, mentionsBot: false };
  const bot = { ...base, name: "小猫", text: "在的", fromBot: true };
  const user = { ...base, name: "张三", text: "你好", fromBot: false, atBot: true };
  const transcript = buildTranscript({
    scope: "group",
    sessionLabel: "测试群",
    botName: "小猫",
    persona: "",
    records: [bot, user],
    pending: new Set([user]),
    stickers: [],
    memories: [],
    now: Date.now(),
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
