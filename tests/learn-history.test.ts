import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageEvent } from "../src/napcat/types.js";

process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "500";
process.env.BOT_PRIVATE_USERS = "";
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.LOG_LEVEL = "silent";

const { runLearnHistory } = await import("../src/cli/learn-history.js");
const { recordsFromHistory } = await import("../src/cli/records.js");
type LearnDeps = Parameters<typeof runLearnHistory>[0];

const SELF = 100;

function event(partial: Partial<MessageEvent> & Pick<MessageEvent, "message_id" | "user_id" | "message">): MessageEvent {
  return {
    post_type: "message",
    message_type: "group",
    group_id: 500,
    self_id: SELF,
    time: partial.message_id,
    sender: { user_id: partial.user_id, nickname: "某人" },
    ...partial,
  };
}

test("same-page @, quote and voice keep structured fields without extra fetches", () => {
  const records = recordsFromHistory(
    [
      event({
        message_id: 1,
        user_id: SELF,
        message: [{ type: "text", data: { text: "你好" } }],
        sender: { user_id: SELF, nickname: "小猫" },
      }),
      event({
        message_id: 2,
        user_id: 7,
        sender: { user_id: 7, card: "张三" },
        message: [
          { type: "reply", data: { id: "1" } },
          { type: "at", data: { qq: String(SELF) } },
          { type: "at", data: { qq: "8", name: "王五" } },
          { type: "record", data: { file: "call.amr" } },
        ],
      }),
      event({
        message_id: 3,
        user_id: 7,
        sender: { user_id: 7, card: "张三" },
        message: "[CQ:at,qq=100] 喂",
      }),
      event({
        message_id: 4,
        user_id: 7,
        sender: { user_id: 7, card: "张三" },
        message: [
          { type: "reply", data: { id: "999" } },
          { type: "record", data: { file: "missing.amr" } },
        ],
      }),
    ],
    SELF,
    "小猫",
  );
  const quoted = records[1]!;
  assert.equal(quoted.text, "@小猫 @王五 [语音]");
  assert.equal(quoted.atBot, true);
  assert.equal(quoted.replyToBot, true);
  assert.equal(quoted.mentionsBot, true);
  assert.deepEqual(quoted.mentions, [8]);
  assert.deepEqual(quoted.mentionNames, ["王五"]);
  assert.deepEqual(quoted.quote, { name: "小猫", text: "你好", fromBot: true });
  assert.equal(records[2]!.text, "[CQ:at,qq=100] 喂");
  assert.equal(records[2]!.atBot, false);
  assert.equal(records[3]!.text, "[语音]");
  assert.equal(records[3]!.replyToBot, false);
  assert.equal(records[3]!.quote, undefined);
});

function harness(options: { failHistory?: boolean; failFlush?: boolean; messages?: MessageEvent[] }) {
  const calls: string[] = [];
  const learned: { scope: string; records: { text: string; atBot: boolean; replyToBot: boolean }[] }[] = [];
  let shutdowns = 0;
  let flushes = 0;
  const messages = options.messages ?? [
    event({ message_id: 1, user_id: 7, message: [{ type: "text", data: { text: "我养猫" } }], sender: { user_id: 7, card: "张三" } }),
  ];
  return {
    calls,
    learned,
    shutdowns: () => shutdowns,
    flushes: () => flushes,
    deps: {
      count: 20,
      groups: [500],
      privateUsers: [] as number[],
      botName: "小猫",
      aliases: [],
      log: () => undefined,
      client: {
        whenOpen: async () => undefined,
        shutdown: async () => {
          shutdowns++;
        },
        callAction: async (action: string) => {
          calls.push(action);
          if (action === "get_login_info") return { data: { user_id: SELF } };
          if (action === "get_group_msg_history") {
            if (options.failHistory) throw new Error("历史拉取失败");
            return { data: { messages } };
          }
          if (action === "get_group_info") return { data: { group_name: "测试群" } };
          throw new Error(`意外的 action ${action}`);
        },
      },
      memory: {
        learn: async (scope: string, _label: string, records: { text: string; atBot: boolean; replyToBot: boolean }[]) => {
          learned.push({ scope, records });
          return 1;
        },
        flush: async () => {
          flushes++;
          if (options.failFlush) throw new Error("readonly");
        },
      },
    },
  };
}

function run(options: { failHistory?: boolean; failFlush?: boolean; messages?: MessageEvent[] }) {
  const made = harness(options);
  return { ...made, result: runLearnHistory(made.deps as LearnDeps) };
}

test("learn-history closes the client on success", async () => {
  const { shutdowns, flushes, calls, learned, result: pending } = run({});
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(shutdowns(), 1);
  assert.equal(flushes(), 1);
  assert.equal(learned.length, 1);
  assert.deepEqual(calls, ["get_login_info", "get_group_msg_history", "get_group_info"]);
});

test("learn-history closes the client when history cannot be fetched", async () => {
  const { shutdowns, flushes, result: pending } = run({ failHistory: true });
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.errors, ["历史拉取失败"]);
  assert.equal(shutdowns(), 1);
  assert.equal(flushes(), 1);
});

test("learn-history exits non-zero when the final save fails and still closes the client", async () => {
  const { shutdowns, result: pending } = run({ failFlush: true });
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.errors, ["保存记忆失败：readonly"]);
  assert.equal(shutdowns(), 1);
});
