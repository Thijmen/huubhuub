# huubhuub

## 0.5.0

### Minor Changes

- [#46](https://github.com/Thijmen/huubhuub/pull/46) [`4547196`](https://github.com/Thijmen/huubhuub/commit/45471961ccd0f5e04103a5f6a31f7c0b74b65605) Thanks [@Thijmen](https://github.com/Thijmen)! - The phone app keeps itself up to date. Over-the-air updates download in the background and start the next time the app is opened after a few minutes away. When an update needs a new APK, the app offers the download instead of silently falling behind. Each APK now stays available on the "app-android" GitHub release, which is also where the invite page's "download the app" link goes by default (`APP_DOWNLOAD_URL`).

## 0.4.0

### Minor Changes

- [#40](https://github.com/Thijmen/huubhuub/pull/40) [`b9e9535`](https://github.com/Thijmen/huubhuub/commit/b9e9535c957ecb26f327ae60d11008480712e97b) Thanks [@Thijmen](https://github.com/Thijmen)! - The phone app now looks like its design. Conversations get an emoji tile and say who spoke last, or that Huub is typing or waiting for an answer. In a conversation, Huub's searches and other steps show as small pills that stay after the reply. Reminders it sets and things it remembers get their own card. The composer, voice recorder, new-conversation screen (with starter ideas), question cards, sign-in and settings screens all got their designed look. Also fixes conversation and settings rows that lost their layout, and a crash when a phone is signed out while a conversation is open.

- [#39](https://github.com/Thijmen/huubhuub/pull/39) [`2919dfe`](https://github.com/Thijmen/huubhuub/commit/2919dfe4da042be2b0751e059cc86d3095db0ac4) Thanks [@Thijmen](https://github.com/Thijmen)! - Link Telegram from the phone app: Settings → Link Telegram opens the bot, and pressing Start makes your app and Telegram one person, with shared conversations, memories and settings. On the admin UI's People page, Link with… does the same for anyone who shows up twice.

## 0.3.0

### Minor Changes

- [#37](https://github.com/Thijmen/huubhuub/pull/37) [`488dfbf`](https://github.com/Thijmen/huubhuub/commit/488dfbfcd91bb3b8d248ada1d2176d3266e9e9d9) Thanks [@Thijmen](https://github.com/Thijmen)! - Pin, archive and search conversations in the phone app. Long-press a conversation to pin it to the top or archive it; writing in an archived conversation brings it back. Search looks through titles and everything that was said.

- [#37](https://github.com/Thijmen/huubhuub/pull/37) [`488dfbf`](https://github.com/Thijmen/huubhuub/commit/488dfbfcd91bb3b8d248ada1d2176d3266e9e9d9) Thanks [@Thijmen](https://github.com/Thijmen)! - Settings in the phone app: pick your persona, see and edit what Huub remembers (and when it may remember things), pause, run or delete your reminders, and see what you've spent against your limits. Failed invite attempts are now what's rate limited, so signing in several phones in a row no longer trips the limit.

- [#37](https://github.com/Thijmen/huubhuub/pull/37) [`488dfbf`](https://github.com/Thijmen/huubhuub/commit/488dfbfcd91bb3b8d248ada1d2176d3266e9e9d9) Thanks [@Thijmen](https://github.com/Thijmen)! - Send voice notes and photos from the phone app. Voice notes are transcribed like Telegram ones (the image now includes `faad` to decode the app's recordings), and photos sent from the app also show up in the Telegram topic. Huub now knows when a conversation happens in the app, and formats replies for it.

## 0.2.0

### Minor Changes

- [#33](https://github.com/Thijmen/huubhuub/pull/33) [`1fa619a`](https://github.com/Thijmen/huubhuub/commit/1fa619a9d81bf66f64b9c5b8bc811e50ca9373fd) Thanks [@Thijmen](https://github.com/Thijmen)! - Add the HuubHuub phone app (Android first) and the server side it talks to. People can be invited with `/app` in Telegram or from the admin UI's People page, and then see and continue their conversations in the app, with live replies, Huub's questions and push notifications. Conversations sync with Telegram for people who use both, and people who don't use Telegram can now use HuubHuub too. The app API runs on a new port, `APP_PORT` (default 8081); set `APP_PUBLIC_URL` to its public HTTPS address to send invites.

## 0.1.0

### Minor Changes

- [#28](https://github.com/Thijmen/huubhuub/pull/28) [`7a56207`](https://github.com/Thijmen/huubhuub/commit/7a562075a5a2333e1e101280ead80b3634872a03) Thanks [@Thijmen](https://github.com/Thijmen)! - Add a Costs page to the admin UI: a chart of spend over time split by model, source or person, with totals, breakdowns and the most expensive sessions.

- [#32](https://github.com/Thijmen/huubhuub/pull/32) [`686f725`](https://github.com/Thijmen/huubhuub/commit/686f725e109496db652d4521cb45d57091c090b7) Thanks [@Thijmen](https://github.com/Thijmen)! - Add spending limits per person and a /costs command. Set a default daily and monthly limit on the Settings page, and give people their own limits or none on the People page. At 80% the person gets a heads-up; at the limit the bot stops, refuses new messages and skips their scheduled prompts until it resets. /costs shows what the current conversation cost and your own spending.

### Patch Changes

- [#32](https://github.com/Thijmen/huubhuub/pull/32) [`cc527fa`](https://github.com/Thijmen/huubhuub/commit/cc527faf084e0bf1e89bc38e771a9739babceea7) Thanks [@Thijmen](https://github.com/Thijmen)! - Keep links in messages you send: text linked to an address (like a photo credit pasted from Unsplash) now reaches the agent with its address, as do code and code blocks. This covers messages, captions, /new and /schedule.

## 0.0.12

### Patch Changes

- [#26](https://github.com/Thijmen/huubhuub/pull/26) [`7200134`](https://github.com/Thijmen/huubhuub/commit/72001349a5b1724a5b797a86c937a51821033669) Thanks [@Thijmen](https://github.com/Thijmen)! - Fix the agent's gh commands failing on repos of an organization the GitHub App is installed on, like `gh repo clone org/repo` run outside a checkout. gh now gets a token for the account the command names.

## 0.0.11

### Patch Changes

- [#24](https://github.com/Thijmen/huubhuub/pull/24) [`c6d61b4`](https://github.com/Thijmen/huubhuub/commit/c6d61b419cfdb50f00653d4df6beba30153eea02) Thanks [@Thijmen](https://github.com/Thijmen)! - Fix the GitHub App not being installable on organizations. New apps are created public so any account you own can install them, and the GitHub page now explains how to make an existing private app public.

## 0.0.10

### Patch Changes

- [#22](https://github.com/Thijmen/huubhuub/pull/22) [`afc42a5`](https://github.com/Thijmen/huubhuub/commit/afc42a56552f7bba8438fc47682f32bc846dee82) Thanks [@Thijmen](https://github.com/Thijmen)! - Fix the model pickers on the admin Settings page opening behind the settings below them, so no model could be picked.

- [#18](https://github.com/Thijmen/huubhuub/pull/18) [`0b20f45`](https://github.com/Thijmen/huubhuub/commit/0b20f45bacd4977e0164e54f10f44197dfeed9c6) Thanks [@Thijmen](https://github.com/Thijmen)! - Fix the "✻ Pondering…" status sometimes staying on screen after the reply arrived in private chats.

## 0.0.9

### Patch Changes

- [#16](https://github.com/Thijmen/huubhuub/pull/16) [`306d0ff`](https://github.com/Thijmen/huubhuub/commit/306d0ff2b8c8fd2ad48a5389e45f07b6c9bc15ab) Thanks [@Thijmen](https://github.com/Thijmen)! - The Docker image is now published as `ghcr.io/thijmen/huubhuub` (was `ghcr.io/thijmen/huub-v2`).

## 0.0.8

### Patch Changes

- [#13](https://github.com/Thijmen/huubhuub/pull/13) [`0ca1b5f`](https://github.com/Thijmen/huubhuub/commit/0ca1b5f35073f54f5d4aac3b1006ecf889dc4ddf) Thanks [@Thijmen](https://github.com/Thijmen)! - Release with Changesets: each release gets a changelog entry, a CHANGELOG.md update and a GitHub release.
