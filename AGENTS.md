# qqbot Agent Notes

- TypeScript QQ bot. NapCat OneBot v11 forward WebSocket (NapCat is the server, bot is the client), like Mist-wu/OvO.
- jev (TypeSafe AI, `@typesafe-ai/sdk`) decides whether to speak and, with a low bar (needs_search > 0.1), whether to offer web search; DeepSeek writes the reply and decides whether to actually search. Only `deepseek-flash` is used — do not add other models or fallbacks.
- Web search and link reading are DeepSeek's built-in server tools (`deepseek_web_search`, `deepseek_read_url`); there is no client-side tool loop. Voice uses DeepSeek's standalone ASR/TTS (`/v1/tools/asr`, `/v1/tools/tts`).
- Personal project: keep modules small and readable, prefer `type`, minimal comments.

## Layout

- `src/napcat/` WS client, OneBot types, segment rendering
- `src/chat/gate.ts` jev questions, thresholds, fallback rules
- `src/chat/runtime.ts` per-session debounce, decide, reply, send
- `src/chat/reply.ts` prompts, output parsing (text lines, `[表情包#id]`, `[语音]` lines), line-by-line vs merged-forward plan, which built-in tools to attach
- `src/chat/stickers.ts` sticker collection, vision descriptions, resend
- `src/chat/voices.ts` voice transcription via NapCat `get_record` (wav) and DeepSeek ASR
- `src/chat/images.ts` / `media.ts` picture descriptions and shared image helpers
- `src/chat/power.ts` admin /启动 /停止 switch, persisted
- `src/chat/memory.ts` per-person long-term memory (group/private scopes), learned after replies
- `src/cli/learn-history.ts` one-off memory backfill from NapCat history
- `src/llm/deepseek.ts` chat completions (with built-in tools), vision, JSON, ASR, TTS
- `deploy/` systemd unit

## Rules that are easy to break

- Built-in tools cannot be combined with `function` tools or `response_format: json_object`, and they ignore `temperature`.
- TTS streams raw WAV; a body shorter than its RIFF header says means synthesis failed midway. A failed voice line is sent as text.
- Voice is `[语音：内容]` in transcripts, both received and sent, same as `[图片：…]`.
- @/reply to the bot is a hint for jev (lower threshold), not a forced reply.
- Transcripts state who talks to whom (`history.ts` `formatLine`/`relation`); keep jev state, reply prompt and memory prompt on the same format.
- Prompts give facts, not rules or examples: no length/tone requirements, no sample phrases (models copy them).

## Workflow

1. Change code, add or update tests in `tests/`.
2. `pnpm test` and `pnpm typecheck`.
