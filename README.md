# OpenCode Telegram bot

A Telegram bot that uses an [OpenCode V2](https://opencode.ai/v2/docs/) server as its AI backend. Each conversation gets its own Telegram thread and its own persistent OpenCode session. Replies stream in live (as a Telegram draft with a stop button in private chats, as message edits in groups), with short status lines for tool calls. A web admin UI manages providers, API keys, MCP servers and settings.

- **Text**: sent to OpenCode as a prompt. Messages sent mid-run are queued.
- **Images and files**: PNG, JPEG, GIF, WebP, and UTF-8 text files are forwarded as attachments. Images need a model with image input.
- **Voice notes**: transcribed with Amazon Transcribe Streaming, then sent as a prompt.
- **Threads**: each new conversation opens its own Telegram topic, named after the session title once OpenCode generates one. See [Threads](#threads).
- **Commands**: `/new [prompt]`, `/stop`, `/model`, `/agent`, `/status`, `/schedule`, `/schedules`, `/skills`, `/whoami`, `/help`
- **Skills**: pull `SKILL.md` skills from (private) GitHub repos through a GitHub App, managed in the admin UI. See [Skills](#skills).
- **Allowlist**: only the Telegram user IDs in `ALLOWED_USER_IDS`, or those added in the admin UI, can use the bot.
- **Admin UI**: connect providers (paste an API key, a whole `.env`, or sign in with OAuth), manage MCP servers, change the default model and agent, and read and reply to conversations live, and open the OpenCode web UI for debugging. See [Admin UI](#admin-ui).

## Architecture

```
Telegram ──long polling──▶ grammY bot (Bun)
                              ├─ opencode serve  child process: OpenCode API + web UI on :4196
                              │    └─ /workspace  the agent's working directory
                              ├─ Amazon Transcribe Streaming (voice → text)
                              ├─ Bun.serve :8080 admin UI (React) + JSON API
                              └─ /data           sessions, thread mapping, settings, OpenCode state
```

| File | Purpose |
| --- | --- |
| `src/index.ts` | Startup and graceful shutdown |
| `src/config.ts` | Validates environment variables |
| `src/opencode.ts` | `Bridge`: the OpenCode client, sessions, and event fan-out |
| `src/opencode-server.ts` | Runs and supervises `opencode serve`, and issues web UI sign-in links |
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
| `src/skills.ts` | Skill repos: clone/pull, scan `SKILL.md`, link enabled skills for OpenCode |
| `src/github-app.ts` | GitHub App: manifest setup, JWTs, installation tokens, installed repos |
| `src/skill-commands.ts` | `/skills` |
| `src/admin/server.ts` | Admin JSON API and static frontend (`Bun.serve`) |
| `src/admin/web/` | Admin frontend (React, no build step) |
| `bot.opencode.jsonc` | OpenCode config: permissions (allow all) and image limits |

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

`./workspace` is mounted as the agent's working directory. Put repositories there, or let the agent clone them. Session state lives in the `bot-data` volume and survives restarts. Port `4196` serves the OpenCode web UI and is bound to `127.0.0.1`, like the admin UI.

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

## Questions

When the agent uses its `question` tool, the bot posts the question with a button per option. Several questions are asked one at a time in the same message, with a "(1/3)" counter.

- Tap an option, or for multi-select questions tick options (☐/☑) and press ✅ Submit.
- Or just type (or say) your own answer: while a question is open, your next message in that thread is the answer.
- ✖ Skip dismisses the whole set. If you don't answer within `QUESTION_TIMEOUT_MINUTES` (default 10, also in the admin UI), the question times out. Either way the agent is told and carries on.
- The same question shows in the admin UI's conversation view. Whichever side answers first wins, and the Telegram message collapses into a summary.

## Scheduled prompts

`/schedule <when> <prompt>` runs a prompt on its own. The bot shows the next run time and asks you to confirm.

| When | Example |
| --- | --- |
| Cron (5 fields) | `/schedule 0 8 * * 1-5 Summarise yesterday's PRs` |
| Shortcuts | `@hourly`, `@daily`, `@daily 08:30` |
| Intervals | `every 30m`, `every 2h` |
| Once | `in 2h`, `at 18:00`, `at 2026-10-01 09:00` |

- Times use `SCHEDULE_TIMEZONE` (default: the server's time zone, also set in the admin UI), including daylight saving changes.
- Each run starts a fresh session in a new topic, `⏰ <name> · <date time>`, or in the main chat if the chat has no topics. The job keeps the model and agent of the thread you created it in.
- **Silent** jobs (toggle it when confirming) may reply `[SILENT]` when there's nothing to report; then nothing is posted. Otherwise their output is posted all at once when the run ends.
- `/schedules` lists this chat's jobs, with buttons to pause or resume, run now, rename and delete.
- If a run is still going when the next one is due, the next one is skipped. Runs that came due while the bot was down are skipped too, except one-off jobs, which run at startup. All of this shows in the run history.
- After 3 failed runs in a row a job pauses itself and tells you.
- The admin UI's **Schedules** page shows every job grouped by chat, with its run history. You can create jobs there and edit any field.

## Skills

The admin UI's **Skills** page loads [agent skills](https://opencode.ai/docs/skills/) from GitHub repos, including private ones. Each skill is a directory with a `SKILL.md` whose frontmatter has a `name` and a `description`.

1. **Connect GitHub**: press *Create GitHub App*. GitHub opens with a prefilled private app that can only read repository contents. Confirm it, and GitHub sends you back to the portal, which stores the app's ID and private key. Fill in an organization first if the app should belong to one.
2. **Install**: press *Install on repos* and pick the repos the bot may read.
3. **Add repo**: pick one of those repos and optionally a branch or tag. The bot checks it can read the repo before saving.

- The bot authenticates as the app. It signs a JWT with the private key and exchanges it for a 1-hour installation token, which is sent to `git` as an HTTP header. No token is stored in `.git/config`, and the agent never sees one. The private key is kept in `/data/bot.sqlite`.
- Every `SKILL.md` in the repo is picked up, and new skills start enabled. Switch individual skills off on the Skills page. A skill without valid frontmatter, or with a name another repo already provides (the first repo added wins), is shown with its error and not loaded.
- Repos are pulled on startup, every `SKILL_SYNC_INTERVAL_MINUTES` (default 60, also in Settings, 0 = off), with **Sync**, and with the button under `/skills` in Telegram. Changes apply live, no restart.
- If a pull fails, for example because the app was uninstalled from the repo, the skills from the last good pull stay loaded and every allowlisted user gets a DM. Another DM follows when the repo syncs again. Reinstalling the app is picked up automatically.
- **Disconnect** forgets the app. It still exists on GitHub; delete it from its settings page if you don't need it.
- Checkouts live in `/data/skills/repos`. Enabled skills are symlinked into `/data/skills/enabled`, which is added to OpenCode's `skills` paths. Removing a repo deletes its checkout.

## Admin UI

The bot serves an admin UI on `ADMIN_PORT` (default `8080`). Sign in with `ADMIN_TOKEN`. If you don't set one, the bot generates a token, stores it in `/data`, and prints it at startup.

- **Providers**: search all integrations OpenCode knows about. Paste an API key, run the OAuth/device-code sign-in, switch between or remove stored credentials, or set the provider's env var.
- **Paste env**: paste a `.env` file, a JSON object or bare keys (recognised by prefix, e.g. `sk-ant-…`). The preview shows where each value goes. A key that belongs to one provider is saved in OpenCode's credential store. Anything else becomes a managed env var, stored in SQLite and exported to the process. OpenCode then restarts (about a second) to pick it up, and running turns resume.
- **Skills**: connect a GitHub App, add the repos it's installed on, toggle skills, and sync. See [Skills](#skills).
- **MCP servers**: add local (command) or remote (URL) servers, paste Claude Desktop / Cursor / OpenCode JSON, enable/disable, reconnect, edit or remove. Changes apply live and are replayed at startup, including removing servers that come from `bot.opencode.jsonc`.
- **Settings**: default model and agent, the Telegram allowlist, thread mode, the question timeout, the schedule time zone and the skill sync interval. Values set here override the environment. "Reset" goes back to the env value.
- **OpenCode** (in the sidebar, plus a card on Overview): opens the real OpenCode web UI in a new tab, signed in with a one-time link. It shows the bot's sessions, the workspace files and a terminal, which helps when debugging. The card shows whether the server is running, its version, and any crash restarts.
- **Conversations**: every thread, live. It streams replies, tool calls and reasoning, with per-turn tokens and cost. You can reply, stop a run, switch model or agent, or start a new topic from the portal. Portal messages are mirrored into Telegram with a 💻 tag, so the reply shows up in both places.

The admin UI can install credentials and run commands through MCP, so treat the token like a root password. `docker-compose.yml` binds the port to `127.0.0.1`. Put a TLS reverse proxy in front before exposing it anywhere else.

### OpenCode server

The bot runs OpenCode as an `opencode serve` child process from the pinned `@opencode/cli` package, on `OPENCODE_PORT` (default `4196`). Sessions are stored in `/data/opencode.sqlite`. If the server crashes, the bot restarts it with backoff and replays the MCP overrides.

- The web UI and API are password protected: `OPENCODE_SERVER_PASSWORD`, or a generated password stored in `/data`. The admin UI's sign-in links mean you don't normally need it. A signed-in browser stays signed in for 30 days.
- Sign-in links point at the admin's host on `OPENCODE_PORT`. Behind a reverse proxy, give OpenCode its own origin (it can't be served from a sub-path) and set `OPENCODE_PUBLIC_URL`.
- To attach the TUI to the bot's server, run `opencode --server http://localhost:4196` and sign in as user `opencode` with the server password.
- The web UI acts on the real sessions. Prompting a bot session from there runs it for real, and the reply may also show up in Telegram.

## Notes

- **Security**: `bot.opencode.jsonc` lets the agent do anything without asking, because the container is the sandbox. It can run any shell command and reach any mounted path, so don't mount secrets you don't want it to use. Keep the allowlist tight.
- **Models**: `/model` lists every enabled model from the configured providers. `DEFAULT_MODEL` (as `provider/model`, or set in the admin UI) applies to new sessions. If it isn't available at startup, the bot falls back to OpenCode's default.
- **Attachments**: PDFs and other binary files aren't passed to the model by OpenCode V2. Convert them to images or text first.
- **Transcribe cost**: the AWS free tier covers 60 min/month for the first 12 months. After that it's about $0.024/min.
- **Corporate TLS proxies**: mount your CA bundle and set `NODE_EXTRA_CA_CERTS`.
