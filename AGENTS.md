# qqbot Agent Notes

- TypeScript QQ bot. NapCat OneBot v11 forward WebSocket (NapCat is the server, bot is the client), like Mist-wu/OvO.
- jev (TypeSafe AI, `@typesafe-ai/sdk`) decides whether to speak and, with a low bar (needs_search > 0.1), whether to offer `web_search`; DeepSeek writes the reply and decides whether to actually search. Only `deepseek-flash` is used — do not add other models or fallbacks.
- Web search uses only Codex (ChatGPT OAuth) credentials via `codex/alpha/search`, mirroring `pi-extensions/websearch`.
- Personal project: keep modules small and readable, prefer `type`, minimal comments.

## Layout

- `src/napcat/` WS client, OneBot types, segment rendering
- `src/chat/gate.ts` jev questions, thresholds, fallback rules
- `src/chat/runtime.ts` per-session debounce, decide, reply, send
- `src/chat/reply.ts` prompts, output parsing (text lines, `[表情包#id]`), line-by-line vs merged-forward plan
- `src/chat/stickers.ts` sticker collection, vision descriptions, resend
- `src/chat/images.ts` / `media.ts` picture descriptions and shared image helpers
- `src/chat/memory.ts` per-person long-term memory (group/private scopes), learned after replies
- `src/cli/learn-history.ts` one-off memory backfill from NapCat history
- `src/llm/deepseek.ts` chat completions with tool loop
- `src/search/` Codex access token (read-only, re-read on expiry) and web search
- `deploy/` systemd unit and `sync-codex-auth.sh`

## Rules that are easy to break

- With tools attached, DeepSeek requires `reasoning_content` of earlier assistant turns to be sent back (400 otherwise).
- The bot only holds a synced Codex access token (no refresh token) and never refreshes: refresh tokens rotate, and the local pi owns this one.
- @/reply to the bot is a hint for jev (lower threshold), not a forced reply.
- Prompts give facts, not rules or examples: no length/tone requirements, no sample phrases (models copy them).

## Workflow

1. Change code, add or update tests in `tests/`.
2. `pnpm test` and `pnpm typecheck`.
