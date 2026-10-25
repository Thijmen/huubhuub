# HuubHuub app

The phone app for HuubHuub (Expo SDK 58, Expo Router). It talks to the bot's app API (`src/app-api/` in the
repo root); the plan and milestones are in [../docs/app/PLAN.md](../docs/app/PLAN.md).

```sh
bun install
bun run start       # Expo dev server; scan the QR code with Expo Go
bun run typecheck
bun run test
```

To sign in during development, create an invite (`/app` in Telegram, or the admin UI's People page) and open
the link on the phone, or paste it on the sign-in screen. The bot's `APP_PUBLIC_URL` must be reachable from
the phone. In Expo Go a local address like `http://<your-ip>:8081` works; APK builds need HTTPS, because
Android blocks plain HTTP in release builds.

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

`.github/workflows/app.yml` builds an APK on EAS when native code changes and publishes an over-the-air update
otherwise. One-time setup:

1. `bunx eas-cli login`, then `bunx eas-cli init` and put the project ID and owner in `app.config.ts`
   (`OFFICIAL_PROJECT_ID`, `OFFICIAL_OWNER`).
2. Firebase: create a project, add an Android app `nl.thijmen.huubhuub`, and upload `google-services.json` to EAS
   as a file environment variable named `GOOGLE_SERVICES_JSON` (preview environment). Upload the FCM V1
   service account key with `bunx eas-cli credentials`.
3. Build once by hand so EAS creates the signing key: `bunx eas-cli build --platform android --profile preview`.
4. Add an Expo access token as the `EXPO_TOKEN` repository secret.
