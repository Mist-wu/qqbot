<div align="center">

# qqbot

**jev 决定该不该说话，deepseek-flash 决定说什么。**

一个跑在 [NapCat](https://github.com/NapNeko/NapCatQQ) 上的 QQ 群聊机器人：会看场合接话、会发表情包、会连发几条、会联网查资料，还记得你在私聊里说过的事。

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![OneBot](https://img.shields.io/badge/OneBot-v11-black)](https://github.com/botuniverse/onebot-11)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

</div>

---

## 亮点

- 像群友一样判断时机：新消息先攒一小批，交给 [jev](https://typesafe.ai)（TypeSafe AI 的决策模型）给出“该不该接话”的概率。被 @ 或被回复只是降低门槛，“哈哈哈”之类的收尾照样可以不回。
- 只用 deepseek-flash 说话：提示词只交代事实（QQ 不渲染 Markdown、每行是一条消息、可以选择不说），不规定长度语气，也不给示例句。
- 表情包：自动收藏群友发的表情包，用 deepseek-flash 识图写描述；模型想发时自己挑。QQ 小黄脸按名字收发（`[doge]` 会发成真表情）。
- 看得懂图片：普通图片也用 deepseek-flash 识图，以 `[图片：描述]` 出现在聊天记录里。
- 听得懂语音：语音消息用 DeepSeek 语音识别转成文字，以 `[语音：内容]` 出现在聊天记录里。
- 会发语音（默认关闭）：回复里以 `[语音]` 开头的一行用 DeepSeek 语音合成读出来，作为语音消息发出；合成失败就发成文字。
- 连发多条，长了就合并转发：每行一条消息，按打字速度间隔发出；回复长到超过 5 行或 300 字时，正文打包成一条合并转发，不刷屏。
- 联网搜索：jev 觉得可能需要查资料时给模型挂上 DeepSeek 内置的联网搜索，搜不搜由模型决定；新消息里有链接时，挂上读链接工具。
- 长期记忆：按人记住聊过的事，群聊和私聊分开记；私聊里说的，到群里它也知道，提不提由它自己判断。
- @ 显示名字：被 @ 的人显示群名片，不会把 QQ 号念出来；它回复里写的 `@名字` 会发成真正的 @。
- 分得清谁在对谁说：聊天记录写成 `说话人 → 对象：正文（引用 某人的「原文」）`，对象来自 @、再退到被引用消息的作者；jev 的输入里也有 `to` / `quoting`。回复机器人的消息却在 @ 别人，就是在跟那个人说。
- 不复读结尾：同一个结尾 emoji / 小黄脸在它最近几条里已经用了两次，这次就去掉。

## 工作原理

```
NapCat ──WS──> 收消息 ──防抖合并──> jev 判断 ──是──> deepseek-flash 生成 ──> 分条发送 / 合并转发
                 │                   │                  │
                 ├─图片/表情包─> 识图   └─否─> 不发言       ├─needs_search > 0.1 ─> 挂上联网搜索
                 ├─语音─> 转文字                           ├─消息里有链接 ─> 挂上读链接
                 └─@某人─> 查群名片                        └─提示词带上相关的人的长期记忆
```

每一批新消息，jev 回答三个是非题（概率 0–1）：

| 问题 | 用途 |
| --- | --- |
| `should_reply` | 达到阈值才发言：群聊 0.6，私聊 0.35。被 @ 或被回复时，取本场景阈值和 0.45 里较小的一个，所以私聊仍是 0.35 |
| `addressed` | 是不是在跟机器人说话，记录在日志里便于调参 |
| `needs_search` | 高于 0.1 就给模型挂上联网搜索 |

机器人最近 5 分钟发了多少言、距上次发言多久，也一起放进 jev 的输入里，让它自己权衡别刷屏，代码里没有硬性冷却。这 5 分钟是固定窗口，环境变量 `GATE_PRESENCE_WINDOW_MS` 不会再生效。jev 不可用时退化为：私聊、被 @、被回复、被点名才回复，纯反应消息不回。

## 快速开始

### 准备

- Node.js ≥ 22、pnpm
- 一个已登录的 NapCat（推荐 [NapCat-Docker](https://github.com/NapNeko/NapCat-Docker)）
- [DeepSeek API key](https://platform.deepseek.com/)
- [TypeSafe API key](https://typesafe.ai)（jev）

### 1. 在 NapCat 里开 WebSocket 服务端

在 NapCat WebUI 的“网络配置”里新建一个 WebSocket 服务端，或者直接写进 `onebot11_<QQ号>.json`：

```json
{
  "network": {
    "websocketServers": [
      {
        "name": "qqbot",
        "enable": true,
        "host": "0.0.0.0",
        "port": 3001,
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "换成一个随机字符串",
        "enableForcePush": true,
        "debug": false,
        "heartInterval": 30000
      }
    ]
  }
}
```

端口不要暴露到公网；Docker 部署时映射成 `127.0.0.1:3001:3001`。`messagePostFormat` 要保持 `array`。整段 CQ 码字符串会被当成普通文字，@ 和引用都认不出来。

### 2. 安装配置

```bash
git clone https://github.com/Mist-wu/qqbot.git && cd qqbot
pnpm install
cp .env.example .env
```

至少填这几项：

```ini
NAPCAT_TOKEN=和 NapCat 里一致
DEEPSEEK_API_KEY=sk-...
TYPESAFE_API_KEY=...
BOT_NAME=机器人的名字
BOT_GROUPS=要发言的群号,逗号分隔
BOT_PRIVATE_USERS=允许私聊的QQ号,逗号分隔
```

`BOT_GROUPS` 和 `BOT_PRIVATE_USERS` 是白名单，为空就不在群里 / 私聊里说话。

`BOT_ADMIN_USERS` 里的 QQ 号可以在私聊里发 `/停止` 让 bot 暂停（不判断、不回复、不收藏表情包、不整理记忆），发 `/启动` 恢复；状态存在 `data/state.json`，重启后保持。进程本身不会退出，所以随时能再 `/启动`。

### 3. 运行

```bash
pnpm build
pnpm start
```

长期运行可以用 `deploy/qqbot.service`（按注释改好用户和路径）：

```bash
sudo install -m 644 deploy/qqbot.service /etc/systemd/system/
sudo systemctl enable --now qqbot
journalctl -u qqbot -f -o cat   # 看每条消息的 jev 分数和决定
```

## 配置

完整列表见 [`.env.example`](.env.example)，常用的：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BOT_PERSONA` | 是群里的一个 AI 群友。 | 人设，接在“你是「名字」，”后面；写得越具体，说话越有性格 |
| `BOT_ALIASES` | | 群友对它的其他称呼，被叫到时 jev 能看到 |
| `GATE_GROUP_THRESHOLD` | 0.6 | 群聊发言阈值，调低更活跃 |
| `GATE_PRIVATE_THRESHOLD` | 0.35 | 私聊发言阈值 |
| `GATE_DIRECT_THRESHOLD` | 0.45 | 被 @ 或被回复时参与比较的阈值。实际取它和当前场景阈值里较小的一个；私聊默认 0.35，不会升到 0.45 |
| `HISTORY_CONTEXT_MESSAGES` | 40 | 给 jev 和模型看的最近消息条数 |
| `GATE_SEARCH_THRESHOLD` | 0.1 | `needs_search` 高于它就挂上搜索工具 |
| `GATE_GROUP_DEBOUNCE_MS` | 3000 | 群里等消息停下多久再判断 |
| `DEEPSEEK_THINKING` | false | deepseek-flash 的思考模式 |
| `DEEPSEEK_TEMPERATURE` | 1.1 | 回复的采样温度；1.3 会冒出奇怪的外文标点和单词 |
| `REPLY_FORWARD_PARTS` / `REPLY_FORWARD_CHARS` | 5 / 300 | 回复超过这么多行或字就改发合并转发 |
| `IMAGES_ENABLED` | true | 普通图片识图 |
| `SEARCH_ENABLED` / `READ_LINKS_ENABLED` | true / true | DeepSeek 内置联网搜索 / 读链接 |
| `VOICES_ENABLED` | true | 语音消息转文字 |
| `TTS_ENABLED` / `TTS_VOICE` | false / stella | 允许回复语音；`stella` 女声，`tide` 男声 |
| `STICKERS_MAX` | 300 | 表情包收藏上限，满了淘汰最少用的 |
| `MEMORY_LEARN_DELAY_MS` | 10000 | 回复后等对话停下多久整理记忆 |
| `MEMORY_LEARN_BATCH` | 30 | 未整理的消息攒够这么多就整理（仅限它最近 30 分钟说过话的会话） |

## 表情包与记忆

- 表情包：收藏表情和商城表情第一次出现时下载下来，deepseek-flash 识图写一句描述，存在 `data/stickers/`。聊天记录里显示为 `[表情包：描述]`；群友发得最多的 40 张打乱顺序后随系统提示词给模型（不按它自己用过的次数排，免得越用越偏向那几张），它单独一行写 `[表情包#编号]` 就会发出去。
- 普通图片：同样识图，但只在内存里缓存描述，不保存图片。
- QQ 小黄脸：收到的显示为 `[名称]`；模型写出已知名称时发成真表情。名称表 [`src/napcat/faces.ts`](src/napcat/faces.ts) 取自 QQ NT 客户端的 `default_config.json`。
- 记忆：bot 回复过后等对话停下，或（在它最近 30 分钟说过话的会话里）未整理的消息攒够一批时，让 deepseek-flash 更新对每个发言者的记忆：只记长期有效的（身份、喜好、关系、重要经历），不记一次性的事和玩笑，也不记住址、学校、联系方式这类隐私。按 QQ 号存在 `data/memory.json`，群聊和私聊分开记。回复时带上聊天里出现的人、以及被 @ 的人的记忆，私聊学到的标注“私聊里告诉你的”。
- 已有聊天记录可以补学一遍：先停掉 bot，再运行 `pnpm learn-history [条数]`，它会从 NapCat 拉白名单私聊和群的最近记录。拉历史或保存失败时，命令以非零状态退出，并关掉连接。

`data/` 里有群友的个人信息和表情包，不要提交或公开。

## 项目结构

```text
src/
├── index.ts              启动、依赖组装
├── config.ts             环境变量
├── logger.ts             日志输出
├── persist.ts            同一文件按提交顺序原子替换
├── napcat/               WS 客户端、OneBot 类型、消息段渲染、QQ 表情表
├── chat/
│   ├── runtime.ts        会话：防抖、判断、回复、发送、触发记忆整理
│   ├── gate.ts           jev 问题与阈值、无 jev 时的兜底
│   ├── reply.ts          提示词、输出解析（文字行 / 表情包 / 语音）、分条或合并转发、工具挂载
│   ├── power.ts          管理员 /启动 /停止 开关与持久化
│   ├── stickers.ts       表情包收藏、识图描述、重发
│   ├── images.ts         普通图片识图
│   ├── media.ts          图片下载、格式识别、描述清理
│   ├── media-cache.ts    图片和语音共用的描述缓存，失败不占位
│   ├── voices.ts         语音消息转文字
│   ├── memory.ts         长期记忆
│   └── history.ts        会话消息记录
├── llm/deepseek.ts       deepseek-flash：回复（内置搜索/读链接）、识图、JSON（失败重试一次）、语音识别与合成
└── cli/learn-history.ts  从历史记录补学记忆
```

## 开发

```bash
pnpm dev         # tsx watch
pnpm test        # node:test，不读本地 .env
pnpm typecheck
```

## 注意

- NapCat 属于非官方客户端，QQ 账号有被风控的风险，建议用小号。
- 记忆、表情包描述和语音转写会把群友的发言交给 DeepSeek 处理，请在群里告知大家。

## 致谢

- [NapCatQQ](https://github.com/NapNeko/NapCatQQ)：OneBot 协议端
- [MaiBot](https://github.com/Mai-with-u/MaiBot)：回复时机、表情包、人物记忆的思路
- [OvO](https://github.com/Mist-wu/OvO)：NapCat 正向 WebSocket 客户端
- [TypeSafe AI](https://typesafe.ai)：jev

## License

[MIT](LICENSE)
