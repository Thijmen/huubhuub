import { InlineKeyboard, type Bot, type Context } from "grammy"
import { truncate } from "./format"
import { formatTime } from "./schedule-spec"
import type { SkillSources, SkillSourceView } from "./skills"

const ICON = { enabled: "✅", disabled: "⏸", error: "⚠️" } as const

/** `/skills`: the skill sources and their skills, with a button to pull them now. Configuration lives in the admin UI. */
export function skillCommands(deps: { skills: SkillSources; timeZone: () => string }) {
  const { skills, timeZone } = deps
  const keyboard = new InlineKeyboard().text("🔄 Sync now", "sk:sync")

  return (bot: Bot) => {
    bot.command("skills", async (ctx) => {
      await ctx.reply(listText(skills.list(), timeZone()), { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } })
    })

    bot.callbackQuery("sk:sync", async (ctx: Context) => {
      await ctx.answerCallbackQuery({ text: "Syncing…" })
      await skills.sync()
      await ctx
        .editMessageText(listText(skills.list(), timeZone()), { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } })
        .catch((err) => {
          if (!String(err).includes("message is not modified")) throw err
        })
    })
  }
}

export function listText(sources: SkillSourceView[], tz: string): string {
  if (sources.length === 0) return "📚 No skill sources yet. Add a GitHub repo on the admin UI's Skills page."
  const blocks = sources.map((s) => {
    const head = `📦 <b>${escape(s.repo)}</b>${s.ref ? ` @ <code>${escape(s.ref)}</code>` : ""}`
    const synced = s.lastSyncAt ? `Synced ${formatTime(s.lastSyncAt, tz)}${s.lastCommit ? ` (<code>${escape(s.lastCommit)}</code>)` : ""}` : "Never synced"
    const lines = [head, `<i>${synced}</i>`]
    if (s.lastError) lines.push(`⚠️ ${escape(s.lastError)}`)
    if (s.checkedOut && s.skills.length === 0) lines.push("No SKILL.md files found.")
    for (const k of s.skills) {
      const detail = k.error ?? k.description ?? ""
      lines.push(`${ICON[k.status]} <b>${escape(k.id)}</b>${detail ? ` – ${escape(truncate(detail, 120))}` : ""}`)
    }
    return lines.join("\n")
  })
  return ["📚 <b>Skills</b>", ...blocks].join("\n\n")
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
