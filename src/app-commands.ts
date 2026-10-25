import type { Bot } from "grammy"
import { AccessError, type AppAccess } from "./app-api/access"
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
