# HuubHuub app

The phone app for HuubHuub (Expo SDK 58, Expo Router). It talks to the bot's app API (`src/app-api/` in the
repo root); the plan and milestones are in [../docs/app/PLAN.md](../docs/app/PLAN.md).

```sh
bun install
bunx expo run:android   # builds a development version, installs it on the phone or emulator and starts Metro
bun run typecheck
bun run test
```

Expo Go can't run the app: it ships other versions of some native modules (notifications). The development
build needs the Android SDK and JDK 17 (`JAVA_HOME`); it generates `android/`, which isn't committed. After the
first build, `bun run start` is enough until the native modules change.

To sign in during development, create an invite (`/app` in Telegram, or the admin UI's People page) and open
the link on the phone, or paste it on the sign-in screen. The bot's `APP_PUBLIC_URL` must be reachable from
the phone. A development build accepts a local address like `http://<your-ip>:8081`; APK builds need HTTPS,
because Android blocks plain HTTP in release builds.

### Without a bot

`bun scripts/app-demo.ts` (from the repo root) serves the app API with made-up Dutch conversations: pinned ones,
a question waiting for an answer, tool activity, a reminder, and a reply that streams in when you send
something. No Telegram or OpenCode needed. It prints an invite; on the Android emulator, which reaches your
computer at `10.0.2.2` (the default host), sign in with `adb shell am start -d '<app link>'`.

## Layout

| Path | What |
| --- | --- |
| `src/app/` | Screens (Expo Router): sign-in, conversation list, chat, settings |
| `src/components/` | Mascot and icons, markdown, bubbles, question card, composer |
| `src/lib/` | API client and live events, session storage, conversation state, push, translations |
| `src/theme.ts` | Colours, radii, spacing and type ("Zondag", see `docs/app/design-proposal.html`) |
| `assets/src/` | Icon sources (SVG); the PNGs next to them are rendered from these with `rsvg-convert -w 1024` |

API types come from `../src/app-api/protocol.ts` (type-only imports through the `@server/*` alias), so the app
and the server can't drift apart.

## Builds and updates

The app ships with each huubhuub release (`.github/workflows/app-release.yml`, called from CI). When the native
code changed, GitHub Actions builds an AAB and uploads it to the Google Play internal testing track; otherwise
it publishes an over-the-air update on the `production` channel. Pull requests say which of the two the next
release will do. Setup and details: [../docs/app/google-play.md](../docs/app/google-play.md).

The app's version is the bot's (the root `package.json`), and its versionCode is derived from it.

**Over-the-air updates** (`src/lib/updates.tsx`) download at launch and whenever the app comes back to the
foreground (at most every 20 minutes). A downloaded update starts the next time the app is opened after five
minutes away, or on a cold start, so it never reloads while someone is typing. Settings → Check for updates
does it right away. New native versions come from Google Play, which updates the app itself.

Expo setup, once: `bunx eas-cli login`, then `bunx eas-cli init` and put the project ID and owner in
`app.config.ts` (`OFFICIAL_PROJECT_ID`, `OFFICIAL_OWNER`). Upload the FCM v1 service account key for push
with `bunx eas-cli credentials`.
