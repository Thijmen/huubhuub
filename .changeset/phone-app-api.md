---
"huubhuub": minor
---

Add the HuubHuub phone app (Android first) and the server side it talks to. People can be invited with `/app` in Telegram or from the admin UI's People page, and then see and continue their conversations in the app, with live replies, Huub's questions and push notifications. Conversations sync with Telegram for people who use both, and people who don't use Telegram can now use HuubHuub too. The app API runs on a new port, `APP_PORT` (default 8081); set `APP_PUBLIC_URL` to its public HTTPS address to send invites.
