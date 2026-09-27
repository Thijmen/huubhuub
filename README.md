# OpenCode Telegram bot

A Telegram bot that uses an embedded [OpenCode V2](https://opencode.ai/v2/docs/) host as its AI backend. Each Telegram chat gets its own persistent OpenCode session. Replies stream in with live message edits and short status lines for tool calls.

- **Text**: sent to OpenCode as a prompt. Messages sent mid-run are queued.
- **Images and files**: PNG, JPEG, GIF, WebP, and UTF-8 text files are forwarded as attachments. Images need a model with image input.
- **Voice notes**: transcribed with Amazon Transcribe Streaming, then sent as a prompt.
- **Commands**: `/new`, `/stop`, `/model`, `/agent`, `/status`, `/whoami`, `/help`
- **Allowlist**: only the Telegram user IDs in `ALLOWED_USER_IDS` can use the bot.

## Architecture

```
Telegram ──long polling──▶ grammY bot (Bun)
                              ├─ @opencode/sdk   embedded OpenCode host (no HTTP listener)
                              │    └─ /workspace  the agent's working directory
                              ├─ Amazon Transcribe Streaming (voice → text)
                              └─ /data           sessions, chat mapping, OpenCode state
```

| File | Purpose |
| --- | --- |
| `src/index.ts` | Startup and graceful shutdown |
| `src/config.ts` | Validates environment variables |
| `src/opencode.ts` | `Bridge`: the embedded host, sessions, and event fan-out |
| `src/stream.ts` | `ChatView`: turns session events into one live Telegram reply |
| `src/reply.ts` | Edits, splitting over 4096 characters, and the typing indicator |
| `src/chats.ts` | Text, photo, document, and voice handlers |
| `src/bot.ts` | Allowlist, commands, and model/agent pickers |
| `src/transcribe.ts` | Amazon Transcribe client (OGG/Opus) |
| `src/format.ts` | Markdown → Telegram HTML, chunking |
| `src/store.ts` | SQLite map of chat → session |
| `opencode.jsonc` | OpenCode config: permissions (allow all) and image limits |

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Run `cp .env.example .env`, then fill in `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`, and at least one provider API key.
   To find your user ID, start the bot and send `/whoami`.
3. For voice notes, add AWS credentials. The IAM principal needs `transcribe:StartStreamTranscription`.

### Docker

```sh
docker compose up -d --build
docker compose logs -f
```

`./workspace` is mounted as the agent's working directory. Put repositories there, or let the agent clone them. Session state lives in the `bot-data` volume and survives restarts.

### Local

```sh
bun install
bun run dev        # WORKSPACE_DIR and DATA_DIR default to /workspace and /data; override them in .env
bun test
bun run typecheck
```

## Notes

- **Security**: `opencode.jsonc` lets the agent do anything without asking, because the container is the sandbox. It can run any shell command and reach any mounted path, so don't mount secrets you don't want it to use. Keep `ALLOWED_USER_IDS` tight.
- **Models**: `/model` lists every enabled model from the configured providers. `DEFAULT_MODEL` (as `provider/model`) applies to new sessions. If it isn't available at startup, the bot falls back to OpenCode's default.
- **Attachments**: PDFs and other binary files aren't passed to the model by OpenCode V2. Convert them to images or text first.
- **Transcribe cost**: the AWS free tier covers 60 min/month for the first 12 months. After that it's about $0.024/min.
- **Corporate TLS proxies**: mount your CA bundle and set `NODE_EXTRA_CA_CERTS`.
