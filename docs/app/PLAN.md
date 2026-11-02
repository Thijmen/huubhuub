# HuubHuub app

A React Native (Expo) phone app for HuubHuub, for people who don't want to use Telegram. First user: Thijmen's girlfriend. HuubHuub is open source and self-hosted, so the app connects to whichever HuubHuub server the person was invited to.

## Decisions

| Topic | Decision |
| --- | --- |
| Telegram | Synced. A conversation started in the app shows up as a Telegram topic for people who also use Telegram, and the other way round. |
| Users | Anyone who self-hosts HuubHuub. The app isn't tied to one server. |
| Telegram account | Optional. People get a bot-owned person ID; Telegram is one way in, the app another. |
| Sign-in | One-time invite (QR code or link) from the admin UI or `/app` in Telegram. The app keeps a long-lived device token. No passwords. |
| Groups | Private conversations only. Group topics stay in Telegram. |
| Platforms | Android first (APK built in GitHub Actions with EAS Build), iOS later from the same code. |
| Updates | OTA through EAS Update; a new APK only when native code changes. |
| Push | Expo push + Firebase (FCM). Notifications show the conversation title and the start of the reply. |
| Network | The app API gets its own port (`APP_PORT`), exposed through TLS. The admin UI stays private. |
| Offline | Always online, no local message cache. |
| Code | `app/` in this repo. One Changesets release covers both. |
| UI | Conversation list on open. Playful, branded look (proposal in `design-proposal.html`). English + Dutch, following the phone. |

## Why she'd prefer it

She doesn't like Telegram itself. So the app does one job: a list of conversations with Huub, each a clean chat. No other chats, no commands, no topic UI. Huub titles conversations automatically; she can pin, archive and search them.

## Architecture

```
Phone (Expo app) ──HTTPS──▶ reverse proxy ──▶ APP_PORT (Bun.serve, app API)
                                                 │  device token → person
                                                 ├─ Chats / Bridge (same as Telegram and the admin UI)
                                                 ├─ SSE per conversation (live reply, questions)
                                                 └─ Expo push API → FCM → phone
Telegram ──long polling──▶ grammY bot ─┘
```

The app API is a per-person version of what the admin UI's conversation view already does (`src/admin/chat.ts`): list conversations, page through messages, stream events over SSE, send, stop, answer questions. The differences are authentication (device tokens instead of the admin token) and scoping (only your own private conversations).

## Identity

Today everything (people, personas, memories, spend limits, thread ownership) is keyed on the Telegram user ID. To make Telegram optional without rewriting those tables:

- `people.user_id` becomes the **person ID**. Existing people keep their Telegram ID as person ID, so no data moves.
- New column `people.telegram_id`. The migration fills it with `user_id` for every existing row.
- People created from the app (no Telegram) get person IDs from `2^52` upwards. Telegram user IDs fit in 52 bits, so the ranges never collide, and the IDs are still safe JavaScript integers.
- Telegram handlers map the sender to a person through `telegram_id`, so someone who starts in the app and links Telegram later stays one person.

## Conversations

Conversations stay rows in `threads`, keyed by `(chat_id, thread_id)`:

- **Person with Telegram and topics on**: a conversation started in the app creates a Telegram topic in their private chat, exactly like the admin UI's "new conversation". Replies stream to both. Messages typed in the app are echoed into the topic as `📱 from the app` so the Telegram side has context. Messages typed in Telegram show in the app because the app reads OpenCode's history.
- **Person without Telegram** (or topics off): the conversation lives in an app-only space: `chat_id` is the person's app chat ID (from `2^52` up, never a Telegram chat), `thread_id` counts up. Nothing is sent to Telegram for these keys.
- New columns on `threads`: `pinned`, `archived_at` (milestone 3).
- Agent features that post into a chat (scheduled runs, spend-limit notices) learn that app-only chats exist: they create an app conversation and send a push instead of calling Telegram.

## App API (`APP_PORT`, default 8081, prefix `/v1`)

| Method | Path | What |
| --- | --- | --- |
| `POST` | `/v1/pair` | Swap an invite code for a device token. Body: code, device name, platform. |
| `GET` | `/v1/me` | Person, server name, features (voice on?), app API version. |
| `DELETE` | `/v1/devices/current` | Sign out this phone. |
| `PUT` | `/v1/devices/current/push` | Register the Expo push token. |
| `GET` | `/v1/conversations` | Own conversations, newest first: title, updated, busy, preview. Later: `?archived=1`, `?q=`. |
| `POST` | `/v1/conversations` | Start one, optionally with the first message. |
| `GET` | `/v1/conversations/:id` | One page of messages (cursor for older), busy state, open question. |
| `GET` | `/v1/conversations/:id/events` | SSE: the session's events and question updates. |
| `POST` | `/v1/conversations/:id/messages` | Send text (later: photo, voice). Answers an open question if there is one. |
| `POST` | `/v1/conversations/:id/stop` | Stop the reply. |
| `POST` | `/v1/conversations/:id/question` | Answer or skip the agent's question. |
| `PATCH` | `/v1/conversations/:id` | Pin, archive (milestone 3). |

Every conversation route checks the conversation belongs to the token's person and is private. Device tokens are random 32-byte strings, stored hashed (SHA-256). Invites are single use, expire after 24 hours, and are stored hashed too. `/v1/pair` is rate limited.

Invite links look like `huubhuub://pair?server=https%3A%2F%2Fhuub.example.com&code=…`. The QR code holds the same link. The server URL comes from a new `APP_PUBLIC_URL` setting.

## Push

- The app registers its Expo push token after sign-in.
- When a reply finishes (`session.execution.succeeded`/`failed`), or the agent asks a question, the server sends a push to the person's devices, unless one of their devices has that conversation open (an SSE stream is connected).
- Body: conversation title, then the first ~150 characters of the reply as plain text.
- Tapping it opens the conversation. Expo push receipts that say `DeviceNotRegistered` remove the token.

## The app (`app/`)

- Expo (latest SDK), Expo Router, TypeScript, installed with Bun.
- `expo-secure-store` for server URL + token, `expo-camera` to scan the invite QR, `expo-notifications`, `expo-updates`, `expo-localization`.
- Streaming with `expo/fetch` (readable streams) for SSE.
- Markdown rendering for replies, tool-activity line while Huub works, stop button, question cards.
- Theme tokens from the chosen brand direction; light and dark.
- Strings in `en` and `nl`.
- API types shared from `src/app-api/protocol.ts` (type-only import, so Metro never bundles server code).

## Build and release

- `app/eas.json`: a `preview` profile that builds an APK (`android.buildType: apk`) on the `preview` channel.
- `runtimeVersion: { policy: "fingerprint" }` so OTA updates only reach builds with matching native code.
- GitHub Actions (`.github/workflows/app.yml`):
  - on pull requests touching `app/`: typecheck and tests.
  - on `main` when `app/` changed: Expo's `continuous-deploy-fingerprint` action builds a new APK when the fingerprint changed, and publishes an OTA update to the `preview` branch otherwise. The build shows up on expo.dev with an install QR code.
- Needs `EXPO_TOKEN` as a repository secret.

## Status

Milestones 1 to 4 are built (October 2026). Milestone 1 is released (huubhuub 0.2.0) with a first APK on EAS; 2 to 4 are in review.

- Server: person IDs and Telegram links, invites and device tokens, the app API with live events, Telegram sync and echo, push notifications, `/app`, invites and signed-in phones on the People page. Voice notes (AAC decoded with `faad`) and photos, pin/archive/search, and the settings endpoints. Covered by tests (`src/app-api/*.test.ts`, `src/chats.test.ts`, `src/audio.test.ts`).
- App: sign-in, conversation list with search, pinned and archived conversations, chat with live streaming, markdown, tool activity, stop, question cards, voice notes and photos, push, settings (persona, memory, reminders, spending), English and Dutch, "Zondag" theme and icons. Typechecks and bundles for Android.
- CI: `.github/workflows/app.yml` (checks on pull requests; APK build or OTA update on main).

## Milestones

1. **Chat core** (what she gets first)
   - Server: person IDs, invites, devices, app API with SSE, Telegram sync and echo, push, `/app` command, invite button on the admin UI's People page.
   - App: pairing (scan or paste), conversation list, chat with live streaming, markdown, tool activity, stop, question cards, push, Dutch/English, brand theme.
   - CI: APK build + OTA.
2. **Voice and photos**: tap-to-record voice notes (the app records AAC, which Android can't do as OGG/Opus; the server decodes it with `faad` and sends PCM to Amazon Transcribe), photos from the camera or gallery.
3. **Organise**: pin, archive, search (titles first, then message text).
4. **Settings**: persona, memory (see, delete), scheduled tasks (see, pause, delete), spending against limits.
5. **Linking**: "Link Telegram" in the app's settings (a one-time `t.me/<bot>?start=link_…` link; the bot merges the two people and allowlists the Telegram user), and "Link with…" on the admin UI's People page for anyone who shows up twice.
6. **Later**: iOS via TestFlight, store listings, share sheet.

## What Thijmen needs to do

- Create an Expo account, run `bunx eas-cli init` in `app/`, and put the project ID and owner in `app/app.config.ts`. Add an access token as `EXPO_TOKEN` in the repo's Actions secrets, and build once by hand (see `app/README.md`).
- Create a Firebase project, add an Android app with the package name `nl.thijmen.huubhuub`, upload `google-services.json` to EAS as the file variable `GOOGLE_SERVICES_JSON`, and upload an FCM v1 service account key (`eas credentials`). Without this, push doesn't work on Android.
- Pick a hostname for the app API (e.g. `huub-app.<domain>`), route it to `APP_PORT` in the cluster with TLS, and set `APP_PUBLIC_URL`.
- Voice notes in the app need the same AWS credentials Telegram voice notes already use.

## Risks

- **Identity migration**: touches personas, memory, spend limits and usage attribution. Covered by tests on an upgraded database before anything ships.
- **Telegram-only assumptions**: code that posts to a chat (`ChatView`, schedule runner, spend notices, memory review) assumes Telegram. App-only chats must never reach the Telegram API; each of those paths gets a guard and a test.
- **SSE on Android**: long-lived streams die when the app is backgrounded. The app reconnects on foreground and reloads the latest page, so nothing is lost; push covers the background.
- **Public API surface**: the app API is internet-facing. Only the routes above, all behind device tokens, rate-limited pairing, no admin capabilities.
