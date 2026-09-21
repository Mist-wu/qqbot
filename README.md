# qqbot

基于 NapCat 的 QQ 聊天机器人：**jev 决定该不该说话，DeepSeek 负责说什么**。

```
NapCat ──WS──> 收消息 ──防抖合并──> jev 判断 ──是──> deepseek-flash 生成 ──> 分条发送（文字/表情包）
                 │                   │                  │
                 └─表情包─> 识图描述   └─否─> 不发言       └─按需─> web_search（Codex 凭证）
```

## 发言逻辑

- 新消息先防抖（群 3s、私聊 1.5s、被 @ 0.8s），连续几条合并成一批交给 jev。
- jev 对三个问题给出概率：`should_reply`（该不该接话）、`addressed`（是不是在跟机器人说）、`needs_search`（要不要联网查）。机器人最近 5 分钟的发言情况也放在 state 里，由 jev 自己权衡。
- `should_reply` 达到阈值才发言。被 @ 或被回复只是降低阈值（0.3），不是必回。
- `needs_search` 高于 0.1 就给 DeepSeek 挂上 `web_search` 工具（Codex token 可用时），真正搜不搜由 DeepSeek 决定；工具走 Codex 的搜索接口。
- 提示词不规定长度、语气，也不给示例，只交代事实：QQ 不渲染 Markdown、每行是一条消息、可以输出 `[不回复]`。
- jev 不可用时退化为：私聊、被 @、被回复、被点名才回复，纯反应消息不回。

## 表情包

- 群友发的表情包（收藏表情、商城表情）第一次出现时下载下来，用 deepseek-flash 识图写一句描述，存在 `data/stickers/`，最多 300 张，满了淘汰最少用的。
- 聊天记录里表情包显示为 `[表情包：描述]`，jev 和 DeepSeek 都能看懂。
- 常用的 40 张随系统提示词给 DeepSeek，它想发时单独一行写 `[表情包#编号]`，发不发、发哪张都由它决定。
- 每行作为一条消息，按打字速度间隔发出，所以会连续发多条。
- QQ 小黄脸：收到的显示为 `[名称]`；模型写出已知名称（如它自己用的 `[doge]`）时，发送成真正的表情，和同一行文字在一条消息里。名称表 `src/napcat/faces.ts` 取自 QQ NT 客户端的 `default_config.json`。

## 记忆

- bot 回复过之后，等对话停下约 10 秒（或者积攒了 30 条新消息），让 deepseek-flash 读一遍这段聊天，更新它对每个人的长期记忆（关于这个人自己、以后用得上的事，纠正过时的）。
- 记忆按 QQ 号存在 `data/memory.json`，群聊和私聊分开记。回复时把聊天记录里出现的人的记忆放进提示词，私聊里学到的标注“私聊里告诉你的”，群里提不提由模型自己决定。
- `pnpm learn-history [条数]` 从 NapCat 拉取白名单私聊和群的最近记录补学一遍；先停掉 bot，否则会被 bot 的保存覆盖。

## 运行

```bash
pnpm install
cp .env.example .env   # 填 DEEPSEEK_API_KEY、TYPESAFE_API_KEY、NAPCAT_TOKEN、BOT_GROUPS、BOT_PRIVATE_USERS
pnpm build
deploy/sync-codex-auth.sh user@host   # 在本机运行：把 pi 的 codex access token 同步到服务器
pnpm start
```

NapCat 需要在 OneBot11 配置里开一个 WebSocket 服务端（`websocketServers`），`messagePostFormat` 用 `array`，token 与 `NAPCAT_TOKEN` 一致。

部署用的 systemd 单元在 `deploy/qqbot.service`。

## 联网搜索

复用 [pi-extensions/websearch](https://github.com/Mist-wu/pi-extensions/tree/main/websearch) 的做法，调用 Codex 的 `POST https://chatgpt.com/backend-api/codex/alpha/search`，只用 ChatGPT（Codex）OAuth 凭证。这是 Codex 源码里的内部 alpha 接口，不是公开 API，协议可能变。

服务器上只放本机 pi 的 codex access token（`data/codex-auth.json`），不带 refresh token，bot 从不刷新，所以不会把本机 pi 的 refresh token 顶掉。access token 过期后搜索自动停用；本机 pi 刷新过之后再运行一次 `deploy/sync-codex-auth.sh user@host`，bot 下次用时会读到新 token，无需重启。

## 开发

```bash
pnpm dev        # tsx watch
pnpm test       # node:test
pnpm typecheck
```
