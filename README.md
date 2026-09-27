# OpenCode Telegram bot

A Telegram bot that uses an embedded [OpenCode V2](https://opencode.ai/v2/docs/) host as its AI backend. Each conversation gets its own Telegram thread and its own persistent OpenCode session. Replies stream in with live message edits and short status lines for tool calls. A web admin UI manages providers, API keys, MCP servers and settings.

- **Text**: sent to OpenCode as a prompt. Messages sent mid-run are queued.
- **Images and files**: PNG, JPEG, GIF, WebP, and UTF-8 text files are forwarded as attachments. Images need a model with image input.
- **Voice notes**: transcribed with Amazon Transcribe Streaming, then sent as a prompt.
- **Threads**: each new conversation opens its own Telegram topic, named after the session title once OpenCode generates one. See [Threads](#threads).
- **Commands**: `/new [prompt]`, `/stop`, `/model`, `/agent`, `/status`, `/whoami`, `/help`
- **Allowlist**: only the Telegram user IDs in `ALLOWED_USER_IDS`, or those added in the admin UI, can use the bot.
- **Admin UI**: connect providers (paste an API key, a whole `.env`, or sign in with OAuth), manage MCP servers, change the default model and agent, and browse conversations. See [Admin UI](#admin-ui).

## Architecture

```
Telegram ──long polling──▶ grammY bot (Bun)
                              ├─ @opencode/sdk   embedded OpenCode host (no HTTP listener)
                              │    └─ /workspace  the agent's working directory
                              ├─ Amazon Transcribe Streaming (voice → text)
                              ├─ Bun.serve :8080 admin UI (React) + JSON API
                              └─ /data           sessions, thread mapping, settings, OpenCode state
```

| File | Purpose |
| --- | --- |
| `src/index.ts` | Startup and graceful shutdown |
| `src/config.ts` | Validates environment variables |
| `src/opencode.ts` | `Bridge`: the embedded host, sessions, and event fan-out |
| `src/stream.ts` | `ChatView`: turns session events into one live Telegram reply |
| `src/reply.ts` | Edits, splitting over 4096 characters, and the typing indicator |
| `src/chats.ts` | Thread routing, plus text, photo, document, and voice handlers |
| `src/bot.ts` | Allowlist, commands, and model/agent pickers |
| `src/transcribe.ts` | Amazon Transcribe client (OGG/Opus) |
| `src/format.ts` | Markdown → Telegram HTML, chunking |
| `src/store.ts` | SQLite: thread → session map, settings, managed env vars, MCP overrides |
| `src/settings.ts` | Runtime settings and managed env vars layered over the environment |
| `src/env-import.ts` | Parses pasted `.env`/JSON/bare keys and decides where each one goes |
| `src/mcp-import.ts` | Parses pasted Claude Desktop / Cursor / OpenCode MCP configs |
| `src/admin/server.ts` | Admin JSON API and static frontend (`Bun.serve`) |
| `src/admin/web/` | Admin frontend (React, no build step) |
| `opencode.jsonc` | OpenCode config: permissions (allow all) and image limits |

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Run `cp .env.example .env`, then fill in `TELEGRAM_BOT_TOKEN`. Everything else can be set in the admin UI, or here: `ALLOWED_USER_IDS`, provider API keys, `ADMIN_TOKEN`.
   To find your user ID, start the bot and send `/whoami`.
3. In @BotFather, open your bot → **Bot Settings** → **Threaded Mode** and turn it on, so private chats get a topic per conversation.
4. For voice notes, add AWS credentials. The IAM principal needs `transcribe:StartStreamTranscription`.

### Docker

```sh
docker compose up -d --build
docker compose logs -f
```

`./workspace` is mounted as the agent's working directory. Put repositories there, or let the agent clone them. Session state lives in the `bot-data` volume and survives restarts.

### Local

```sh
bun install
bun run dev        # uses ./workspace and ./data locally (both gitignored); override with WORKSPACE_DIR / DATA_DIR
bun test
bun run typecheck
```

## Threads

With `THREAD_MODE=auto` (the default), every conversation lives in its own Telegram topic:

- **Private chats** need Threaded Mode turned on for the bot in @BotFather. A message sent outside a topic starts a new topic ("New conversation"). The bot renames it once OpenCode has titled the session.
- **Groups** need to be forum supergroups (topics enabled). Each topic is a separate session.
- `/new` opens a fresh topic. `/new fix the flaky test` opens one and sends the prompt straight away.
- A new thread inherits the model and agent of the chat's most recent conversation.
- If topics aren't available, or `THREAD_MODE=off`, the bot falls back to one session per chat, and `/new` resets it.

## Admin UI

The bot serves an admin UI on `ADMIN_PORT` (default `8080`). Sign in with `ADMIN_TOKEN`. If you don't set one, the bot generates a token, stores it in `/data`, and prints it at startup.

- **Providers**: search all integrations OpenCode knows about. Paste an API key, run the OAuth/device-code sign-in, switch between or remove stored credentials, or set the provider's env var.
- **Paste env**: paste a `.env` file, a JSON object or bare keys (recognised by prefix, e.g. `sk-ant-…`). The preview shows where each value goes. A key that belongs to one provider is saved in OpenCode's credential store. Anything else becomes a managed env var, stored in SQLite and exported to the process. Models appear straight away, without a restart.
- **MCP servers**: add local (command) or remote (URL) servers, paste Claude Desktop / Cursor / OpenCode JSON, enable/disable, reconnect, edit or remove. Changes apply live and are replayed at startup, including removing servers that come from `opencode.jsonc`.
- **Settings**: default model and agent, the Telegram allowlist, and thread mode. Values set here override the environment. "Reset" goes back to the env value.
- **Conversations**: every thread with its session title, model, token usage and cost.

The admin UI can install credentials and run commands through MCP, so treat the token like a root password. `docker-compose.yml` binds the port to `127.0.0.1`. Put a TLS reverse proxy in front before exposing it anywhere else.

## Notes

- **Security**: `opencode.jsonc` lets the agent do anything without asking, because the container is the sandbox. It can run any shell command and reach any mounted path, so don't mount secrets you don't want it to use. Keep the allowlist tight.
- **Models**: `/model` lists every enabled model from the configured providers. `DEFAULT_MODEL` (as `provider/model`, or set in the admin UI) applies to new sessions. If it isn't available at startup, the bot falls back to OpenCode's default.
- **Attachments**: PDFs and other binary files aren't passed to the model by OpenCode V2. Convert them to images or text first.
- **Transcribe cost**: the AWS free tier covers 60 min/month for the first 12 months. After that it's about $0.024/min.
- **Corporate TLS proxies**: mount your CA bundle and set `NODE_EXTRA_CA_CERTS`.
