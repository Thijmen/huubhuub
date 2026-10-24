# HuubHuub

HuubHuub is a Telegram bot that uses an [OpenCode V2](https://opencode.ai/v2/docs/) server as its AI backend. Each conversation gets its own Telegram thread and its own persistent OpenCode session. Replies stream in live (as a Telegram draft with a stop button in private chats, as message edits in groups), with short status lines for tool calls. A web admin UI manages providers, API keys, MCP servers and settings.

- **Text**: sent to OpenCode as a prompt. Messages sent mid-run are queued.
- **Images and files**: PNG, JPEG, GIF, WebP, and UTF-8 text files are forwarded as attachments. Images need a model with image input.
- **Voice notes**: transcribed with Amazon Transcribe Streaming, then sent as a prompt.
- **Threads**: each new conversation opens its own Telegram topic, named after the session title once OpenCode generates one. See [Threads](#threads).
- **Commands**: `/new [prompt]`, `/stop`, `/model`, `/agent`, `/status`, `/costs`, `/schedule`, `/schedules`, `/skills`, `/persona`, `/memory`, `/forget`, `/whoami`, `/help`
- **Costs and spending limits**: see what sessions cost over time in the admin UI, `/costs` in a chat, and daily or monthly limits per person. See [Costs and spending limits](#costs-and-spending-limits).
- **Personas and memory**: each Telegram user gets a persona (who the bot is: name, tone, house rules) and a long-term memory that carries over between conversations. See [Personas and memory](#personas-and-memory).
- **Scheduled tasks**: prompts or shell commands on a cron, interval or one-off schedule, posted in a chat or run in the background. The agent can schedule things itself. See [Scheduled tasks](#scheduled-tasks).
- **GitHub**: one GitHub App, set up from the admin UI, gives the agent `gh` and `git` access to the repos you pick. See [GitHub](#github).
- **Skills**: pull `SKILL.md` skills from (private) GitHub repos through the same GitHub App, managed in the admin UI. See [Skills](#skills).
- **Allowlist**: only the Telegram user IDs in `ALLOWED_USER_IDS`, or those added in the admin UI, can use the bot.
- **Admin UI**: connect providers (paste an API key, a whole `.env`, or sign in with OAuth), manage MCP servers, change the default model and agent, read and reply to conversations live, see what sessions cost over time, and open the OpenCode web UI for debugging. See [Admin UI](#admin-ui).

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
| `src/github-app.ts` | GitHub App: manifest setup, JWTs, installation tokens, installations |
| `src/github-access.ts` | The agent's GitHub access: picks an installation per repo owner, writes the git config agent processes include |
| `src/internal.ts` | Loopback API for the OpenCode plugin and the git credential helper |
| `src/agent-plugin/` | OpenCode plugin: the agent's `schedule_*` tools, and `GH_TOKEN` for every shell command |
| `bin/git-credential-bot` | git credential helper that asks the bot for an installation token |
| `src/scheduler.ts` | Fires due jobs, logs missed and skipped runs, pauses jobs that keep failing |
| `src/schedule-runner.ts` | Runs a job: a prompt in a fresh session, or a shell command; posts the result |
| `src/schedule-service.ts` | Validation shared by the admin UI and the agent's tools |
| `src/agent-schedules.ts` | What the `schedule_*` tools do, scoped to the conversation's chat |
| `src/skill-commands.ts` | `/skills` |
| `src/personas.ts` | Personas and memory per user: who a session talks to, and what goes into its system prompt |
| `src/persona-commands.ts` | `/persona`, `/memory`, `/forget` |
| `src/admin/server.ts` | Admin JSON API and static frontend (`Bun.serve`) |
| `src/usage.ts` | Spend per hour, session and model, summed from the cost OpenCode records on each model call, plus calls as they finish |
| `src/spend-limits.ts` | Daily and monthly spending limits per person: warn, refuse new work, stop running work |
| `src/cost-commands.ts` | `/costs` |
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

CI (`.github/workflows/ci.yml`) runs the typecheck and tests on every pull request. Releases go through [Changesets](https://changesets.dev): each pull request adds an entry with `bun run changeset`, and merging to `main` keeps a "Release huubhuub" pull request up to date with the version bump and `CHANGELOG.md`. Merging that pull request tags `vX.Y.Z`, publishes a GitHub release with the changelog, builds the image for `linux/amd64` and `linux/arm64`, and publishes it as `ghcr.io/thijmen/huubhuub:X.Y.Z` and `:latest` (plus a `sha-…` tag). To run that instead of building locally, set `image: ghcr.io/thijmen/huubhuub:latest` in `docker-compose.yml`, remove `build: .`, and `docker login ghcr.io` (the package is private).

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

## Scheduled tasks

`/schedule <when> <prompt>` runs a prompt on its own. The bot shows the next run time and asks you to confirm. Start the prompt with `$` to run a shell command instead: `/schedule every 1h $ ./check-disk.sh`. Or just ask the agent ("remind me every Monday at 9 to…"); it has tools to list, create, change, pause and run schedules.

| When | Example |
| --- | --- |
| Cron (5 fields) | `/schedule 0 8 * * 1-5 Summarise yesterday's PRs` |
| Shortcuts | `@hourly`, `@daily`, `@daily 08:30` |
| Intervals | `every 30m`, `every 2h` |
| Once | `in 2h`, `at 18:00`, `at 2026-10-01 09:00` |

A task is one of:

- **Prompt**: each run starts a fresh session with the prompt. The job keeps the model and agent of the thread you created it in.
- **Command**: runs with bash in the workspace, with the agent's environment (so `gh` and `git` use the [GitHub App](#github)). It's stopped after 15 minutes. Its output is posted, or kept in the run history.
- **Prompt with a pre-check**: a command runs first. The prompt only runs when the command exits 0 and prints something, and gets that output appended. Good for cheap polling: `gh pr list --repo acme/api --label needs-review` costs no tokens when there's nothing to review. A failing pre-check counts as a failed run.

Where results go:

- **A chat**: prompt runs open a new topic, `⏰ <name> · <date time>`, or use the main chat if it has no topics. Command output is posted in the main chat.
- **Background**: nothing is posted. Output and sessions show in the run history on the admin UI's Schedules page.

Other behaviour:

- Times use `SCHEDULE_TIMEZONE` (default: the server's time zone, also set in the admin UI), including daylight saving changes.
- **Silent** jobs only post when there's something to report. A prompt job's agent replies `[SILENT]` when there's nothing; a command job stays quiet when it prints nothing. Otherwise a silent prompt's output is posted all at once when the run ends.
- `/schedules` lists this chat's jobs, with buttons to pause or resume, run now, rename and delete. ⚙️ marks commands and 🤖 jobs the agent made.
- If a run is still going when the next one is due, the next one is skipped. Runs that came due while the bot was down are skipped too, except one-off jobs, which run at startup. All of this shows in the run history.
- After 3 failed runs in a row a job pauses itself and tells you. Background jobs tell every allowlisted user.
- The agent sees the jobs of the chat it's talking in, plus the background ones. Jobs it makes can't run more often than every 5 minutes, and it can have at most 20.
- The admin UI's **Schedules** page shows every job grouped by chat, with its run history and output. You can create jobs there and edit any field, including where results go.

## Personas and memory

Every conversation gets a persona and the user's memories added to OpenCode's own system prompt, through the bot's OpenCode plugin. Both are per Telegram user, so different people can talk to different personas.

- **Personas**: the admin UI's **Personas** page holds the personas: a name and instructions (character, language, tone, house rules). On first start the bot creates **Huub**, ported from huub v1, and makes it the default. Pick another default, or none for OpenCode's plain assistant.
- **Per user**: people pick their own with `/persona`, or you set it on the **People** page. Changes apply from the next message, also in running conversations.
- **Who a conversation is with**: in a private chat, that user. In a group, whoever wrote last. Scheduled runs in a chat use that chat's user. Background runs get the default persona and no memory. Sessions the bot didn't start, like ones opened in the OpenCode web UI or subagents, are left alone.
- **Also added**: the user's name, today's date in `SCHEDULE_TIMEZONE`, and a short note on what Telegram can render.

Memory has three modes, per user (`/memory`, or the People page), with a default on the Personas page:

| Mode | What the agent does |
| --- | --- |
| **Off** | Remembers nothing between conversations. |
| **When asked** (default) | Only saves something when told to ("remember that…", "onthoud dat…"). It never saves or offers to on its own. |
| **Automatic** | Also saves personal facts the user shares on their own, like people in their life, pets, work, hobbies or favourite teams. After each reply, a separate call to the conversation's model reviews the exchange; anything it saves is posted in the thread as "🧠 Remembered: …" with a **Forget** button. |

- All of a user's memories go into the system prompt; there's no separate lookup step. The agent is told to use them only when relevant.
- The agent changes them with its `memory_save`, `memory_update` and `memory_forget` tools, which only reach the current user's memories. In Automatic mode it only uses them when asked to remember, correct or forget something; the review step handles the rest, so saving doesn't depend on the chat model noticing.
- The review costs one extra, small model call per reply, and only runs for users in Automatic mode. It skips scheduled runs and never saves secrets or health and financial details.
- The review uses the conversation's model, or the **Memory model** from Settings (`MEMORY_MODEL`); a small, fast model is plenty. It runs in an empty "Memory review" session the bot keeps per model, so it only sends the review prompt (no conversation history, tools or agent prompt), and it works with OpenCode's free models, which refuse calls made outside a session.
- `/memory` lists them and switches the mode; `/forget 12` deletes one; "Forget everything" wipes them. The People page shows who saved what, lets you edit, add and delete memories, and previews the full system prompt a user gets.
- The People page also lists each person's conversations. Open one to see every tool call in it, newest first, with a count per tool and how many failed; expand a call for its input and output. Code Mode `execute` calls show the tools their script called, e.g. `execute → memory_save`. In groups, a conversation is listed under whoever wrote in it last.
- A memory is one sentence of at most 500 characters, and a user can have up to 100.

## Costs and spending limits

OpenCode records the price of every model call. The bot adds these up per session, model and person.

- **Costs page** in the admin UI: spend over time split by model, source (conversations, scheduled tasks, memory reviews) or person, with the most expensive sessions.
- **`/costs`** in Telegram: what the conversation in that thread has cost, including its subagents, and what the sender has spent today and this month against their limits.
- **Limits**: a default daily and monthly limit in dollars on the Settings page (`SPEND_LIMIT_DAILY`, `SPEND_LIMIT_MONTHLY`; empty means none). On the People page each person can get their own limits, or **No limits** (for yourself, say).
  - At 80% of a limit the person gets a heads-up in the thread.
  - At the limit, new messages are refused with when the limit resets, and a reply that's still running is stopped after the model call that crossed it.
  - Scheduled prompts that post in the person's private chat are skipped until it resets; shell-command tasks still run.
  - Days and months follow `SCHEDULE_TIMEZONE`.
- **Who pays**: a conversation's spend counts towards whoever it's with (see [who a conversation is with](#personas-and-memory)), including subagents it starts. In groups that is whoever wrote last. Scheduled tasks count towards the person whose private chat they post in. Memory reviews and background jobs count towards nobody.

## GitHub

The admin UI's **GitHub** page connects one GitHub App. The agent uses it for `gh` and `git`, and the bot uses it to pull [skill repos](#skills).

1. **Create**: press *Create GitHub App*. GitHub opens with a prefilled private app that may read and write code, pull requests and issues, and read Actions and checks. Confirm it, and GitHub sends you back to the portal, which stores the app's ID and private key. Fill in an organization first if the app should belong to one.
2. **Install**: press *Install on repos* and pick the accounts and repos the bot may use. Install it on more accounts any time.

What the agent gets:

- **`gh`**: every shell command the agent runs gets a fresh installation token as `GH_TOKEN`, through the bot's OpenCode plugin. Inside a checkout the token is for the account that owns its `origin`; elsewhere it's for the default installation, which you can change on the GitHub page. A `GH_TOKEN` or `GITHUB_TOKEN` you set yourself (for example a pasted PAT) takes precedence.
- **`git`**: OpenCode and everything it starts include `/data/github/gitconfig`, which points github.com at `bin/git-credential-bot`. The helper asks the bot for a token for the repo's owner, so clone, fetch and push need no setup. It replaces any credential helper from your own git config for github.com, but only while an app is connected.
- **Commits** are authored as `<app>[bot]`, so GitHub links them to the app.
- **Scheduled commands** get the same access.

Notes:

- Installation tokens last an hour. The bot mints them on demand and keeps them in memory only; each shell command gets one that's valid for at least 20 more minutes.
- The tokens act as the app, not as you. Commands that need a user, such as `gh pr status` or searches with `@me`, don't work.
- The agent can read the token from its environment and ask the bot's loopback API for more. That's no more than it can already do with `gh`, but keep the installations to repos you're happy for it to change.
- An app created by an earlier version only asked to read code. The GitHub page says what's missing. Raise the permissions in the app's settings, then accept the change on each installation.
- The Docker image includes the GitHub CLI. When running locally, install it yourself.

## Skills

The admin UI's **Skills** page loads [agent skills](https://opencode.ai/docs/skills/) from GitHub repos, including private ones. Each skill is a directory with a `SKILL.md` whose frontmatter has a `name` and a `description`.

1. **Connect GitHub** on the [GitHub](#github) page, and install the app on your skill repos.
2. **Add repo**: pick one of those repos and optionally a branch or tag. The bot checks it can read the repo before saving.

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
- **GitHub**: create and install the GitHub App, see which accounts it's installed on and whether they've granted everything, and pick the default account for `gh`. See [GitHub](#github).
- **Skills**: add the repos the GitHub App is installed on, toggle skills, and sync. See [Skills](#skills).
- **MCP servers**: add local (command) or remote (URL) servers, paste Claude Desktop / Cursor / OpenCode JSON, enable/disable, reconnect, edit or remove. Changes apply live and are replayed at startup, including removing servers that come from `bot.opencode.jsonc`.
- **Settings**: default model and agent, the memory model, the Telegram allowlist, thread mode, the question timeout, the schedule time zone and the skill sync interval. Values set here override the environment. "Reset" goes back to the env value.
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
