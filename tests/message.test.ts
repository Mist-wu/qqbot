import assert from "node:assert/strict";
import { test } from "node:test";

import {
  atTargets,
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
