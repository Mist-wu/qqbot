import assert from "node:assert/strict";
import { test } from "node:test";

import {
  atTargets,
  markdownToText,
  hasText,
  isAtSelf,
  renderSegments,
  replyTargetId,
  textToSegments,
  toSegments,
} from "../src/napcat/message.js";

const ctx = { selfId: 100, botName: "小猫" };

test("renders text, at and media placeholders", () => {
  const segments = toSegments([
    { type: "reply", data: { id: "55" } },
    { type: "at", data: { qq: "100" } },
    { type: "text", data: { text: "你看这个" } },
    { type: "image", data: { sub_type: 0 } },
    { type: "at", data: { qq: "200", name: "张三" } },
    { type: "face", data: { id: "14" } },
  ]);
  assert.equal(renderSegments(segments, ctx), "@小猫 你看这个[图片]@张三 [微笑]");
  assert.equal(isAtSelf(segments, 100), true);
  assert.equal(isAtSelf(segments, 999), false);
  assert.equal(replyTargetId(segments), 55);
});

test("string messages become a single text segment", () => {
  const segments = toSegments("hello");
  assert.deepEqual(segments, [{ type: "text", data: { text: "hello" } }]);
  assert.equal(hasText(segments), true);
  assert.equal(hasText(toSegments([{ type: "image", data: {} }])), false);
});

test("sticker images and @all", () => {
  const segments = toSegments([
    { type: "at", data: { qq: "all" } },
    { type: "image", data: { sub_type: 1 } },
  ]);
  assert.equal(renderSegments(segments, ctx), "@全体成员 [表情包]");
});

test("incoming faces render by name, unknown ids as a placeholder", () => {
  const segments = toSegments([
    { type: "face", data: { id: "179" } },
    { type: "face", data: { id: "99999" } },
  ]);
  assert.equal(renderSegments(segments, ctx), "[doge][表情]");
});

test("known face names become face segments inline with text", () => {
  assert.deepEqual(textToSegments("难道你怀疑我是机器人？[doge]"), [
    { type: "text", data: { text: "难道你怀疑我是机器人？" } },
    { type: "face", data: { id: "179" } },
  ]);
  assert.deepEqual(textToSegments("[捂脸]不是吧[不存在的表情] ok"), [
    { type: "face", data: { id: "264" } },
    { type: "text", data: { text: "不是吧[不存在的表情] ok" } },
  ]);
  assert.deepEqual(textToSegments("没有表情"), [{ type: "text", data: { text: "没有表情" } }]);
});

test("@ of other users shows a name, never the raw QQ number", () => {
  const segments = toSegments([
    { type: "at", data: { qq: "100" } },
    { type: "text", data: { text: "你还记得" } },
    { type: "at", data: { qq: "123456789" } },
    { type: "text", data: { text: "吗" } },
    { type: "at", data: { qq: "555" } },
  ]);
  const atName = (id: number) => (id === 123456789 ? "路人甲" : undefined);
  assert.equal(renderSegments(segments, { ...ctx, atName }), "@小猫 你还记得@路人甲 吗@某人");
  assert.deepEqual(atTargets(segments, 100), [123456789, 555]);
});

test("markdown messages render once, without LaTeX styling", () => {
  const latex = "$\\scalebox{5.0}{\\colorbox{black}{\\textcolor{white}{\\text{\\scalebox{6.0}{\\colorbox{black}{\\textcolor{white}{\\text{666}}}}}}}}$";
  const segments = toSegments([
    { type: "markdown", data: { content: latex } },
    { type: "text", data: { text: latex } },
  ]);
  assert.equal(renderSegments(segments, ctx), "666");
  assert.equal(markdownToText("$\\textcolor{#FC5C7D}{就}\\textcolor{#DF6496}{只}$"), "就只");
  assert.equal(markdownToText("$\\Huge 何\\Huge 意\\Huge 味$"), "何意味");
  assert.equal(markdownToText("$\\colorbox{#FF0000}{\\color{white}{红底白字}}$"), "红底白字");
  assert.equal(markdownToText("# 一级标题\n**正文**"), "一级标题\n正文");
});

test("pictures show their description when known", () => {
  const segments = toSegments([
    { type: "image", data: { sub_type: 0, file: "p" } },
    { type: "image", data: { sub_type: 1, file: "s" } },
  ]);
  const imageText = (seg: { data: Record<string, unknown> }) => (seg.data.file === "p" ? "一张截图" : "猫猫叹气");
  assert.equal(renderSegments(segments, { ...ctx, imageText }), "[图片：一张截图][表情包：猫猫叹气]");
});

test("@名字 of known members becomes a real mention; names may contain spaces", () => {
  const members = new Map([["李四", 42], ["🌟- PP( ˘ 🐽˘)❤", 77], ["李", 1]]);
  assert.deepEqual(textToSegments("@李四 处理什么[doge]", members), [
    { type: "at", data: { qq: "42" } },
    { type: "text", data: { text: " " } },
    { type: "text", data: { text: "处理什么" } },
    { type: "face", data: { id: "179" } },
  ]);
  assert.deepEqual(textToSegments("问问@🌟- PP( ˘ 🐽˘)❤", members), [
    { type: "text", data: { text: "问问" } },
    { type: "at", data: { qq: "77" } },
  ]);
  assert.deepEqual(textToSegments("邮箱a@b.com @路人", members), [{ type: "text", data: { text: "邮箱a@b.com @路人" } }]);
});

test("markdown links and images render as plain text", () => {
  assert.equal(markdownToText("[@OvO](mqqapi://markdown/mention?at_type=1&at_tiny_id=1) 你好"), "@OvO 你好");
  assert.equal(markdownToText("看 ![star #20px](https://x/s.png) 和 [完整榜单](https://github.com/trending)"), "看 [图片] 和 完整榜单");
});
