import type { Bot } from "grammy"
import { AccessError, type AppAccess } from "./app-api/access"
import { LINK_START, LinkError, type TelegramLinks } from "./app-api/telegram-link"
import type { Chats } from "./chats"

/** `/app`: a one-time link that signs a phone in to the app as this Telegram user. */
export function appCommands(d: { access: AppAccess }) {
  return (bot: Bot, chats: Chats) => {
    bot.command("app", async (ctx) => {
      if (ctx.chat.type !== "private" || !ctx.from) return void (await ctx.reply("Ask me for an app invite in our private chat."))
      try {
        const { url } = d.access.invite(chats.personOf(ctx.from))
        await ctx.reply(
          [
            "📱 Open this link on the phone you want to use HuubHuub on. It signs that phone in as you, works once, and expires in 24 hours. Don't share it.",
            "",
            url,
            "",
            "Your conversations here show up in the app, and new ones from the app show up here.",
          ].join("\n"),
          { link_preview_options: { is_disabled: true } },
        )
      } catch (err) {
        if (!(err instanceof AccessError)) throw err
        await ctx.reply(`⚠️ ${err.message}`)
      }
    })
  }
}

/**
 * `/start link_<code>`, sent by the "Link Telegram" button in the app: makes this Telegram user and the app
 * person one. Runs before the allowlist, since the person may not be on it yet; the one-time code is the proof.
 */
export function telegramLinkCommand(d: { links: Pick<TelegramLinks, "redeem"> }) {
  return (bot: Bot) => {
    bot.chatType("private").hears(LINK_START, async (ctx) => {
      const code = ctx.match[1]!
      const from = ctx.from
      try {
        const person = d.links.redeem(code, { id: from.id, name: [from.first_name, from.last_name].filter(Boolean).join(" ") || null, username: from.username ?? null })
        await ctx.reply(
          [
            `🔗 Linked! You're ${person.name ?? from.first_name} in the HuubHuub app too. Conversations, memories and settings are now shared.`,
            "",
            "Write to me here or in the app, whichever is handy. Send /help to see what I can do here.",
          ].join("\n"),
        )
      } catch (err) {
        if (!(err instanceof LinkError)) throw err
        await ctx.reply(err.message)
      }
    })
  }
}
