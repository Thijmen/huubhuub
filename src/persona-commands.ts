import { InlineKeyboard, type Bot, type Context } from "grammy"
import { truncate } from "./format"
import type { Personas } from "./personas"
import type { MemoryMode, Store } from "./store"

const MODE_LABELS: Record<MemoryMode, string> = { off: "Off", explicit: "When asked", auto: "Automatic" }
const MODE_HELP: Record<MemoryMode, string> = {
  off: "I don't remember anything between conversations.",
  explicit: "I only remember things when you ask me to (\"remember that…\").",
  auto: "I remember things you ask me to, and now and then something important on my own. I'll tell you when I do.",
}

/** `/persona`, `/memory`, `/forget` and their buttons. Everything applies to the person who sends them. */
export function personaCommands(deps: { store: Store; personas: Personas }) {
  const { store, personas } = deps

  const personaView = (userId: number) => {
    const own = store.person(userId)?.personaId ?? null
    const current = personas.personaFor(userId)
    const fallback = personas.personaFor(null)
    const kb = new InlineKeyboard()
    store.personas().forEach((p, i) => {
      kb.text(`${own === p.id ? "● " : ""}${truncate(p.name, 30)}`, `pe:${p.id}`)
      if (i % 2 === 1) kb.row()
    })
    kb.row().text(`${own === null ? "● " : ""}Default${fallback ? ` (${truncate(fallback.name, 24)})` : ""}`, "pe:d")
    const text = current ? `🎭 You're talking to <b>${escape(current.name)}</b>${own === null ? " (the default)" : ""}.` : "🎭 No persona: you get OpenCode's own assistant."
    return { text: `${text}\nPick another one:`, kb }
  }

  const memoryView = (userId: number) => {
    const mode = personas.memoryMode(userId)
    const list = store.memories(userId)
    const lines = [`🧠 <b>Memory: ${MODE_LABELS[mode]}</b>`, MODE_HELP[mode], ""]
    if (list.length) {
      lines.push(`What I remember about you (${list.length}):`)
      for (const m of list) lines.push(`<code>#${m.id}</code> ${escape(truncate(m.text, 200))}`)
      lines.push("", "<i>/forget 12 removes #12. You can also just tell me to forget or correct something.</i>")
    } else lines.push("I don't remember anything about you yet.")
    const kb = new InlineKeyboard()
    for (const m of ["off", "explicit", "auto"] as const) kb.text(`${m === mode ? "● " : ""}${MODE_LABELS[m]}`, `mm:${m}`)
    if (list.length) kb.row().text("🗑 Forget everything", "mf:ask")
    return { text: truncate(lines.join("\n"), 4000), kb }
  }

  return (bot: Bot) => {
    bot.command("persona", async (ctx) => {
      const userId = ctx.from?.id
      if (!userId) return
      const name = ctx.match.trim().toLowerCase()
      if (name) {
        const match = store.personas().find((p) => p.name.toLowerCase() === name)
        if (!match) return void (await ctx.reply(`There's no persona called ${escape(ctx.match.trim())}. Send /persona to see them.`, { parse_mode: "HTML" }))
        store.updatePerson(userId, { personaId: match.id })
        return void (await ctx.reply(`🎭 You're now talking to <b>${escape(match.name)}</b>.`, { parse_mode: "HTML" }))
      }
      const v = personaView(userId)
      await ctx.reply(v.text, { parse_mode: "HTML", reply_markup: v.kb })
    })

    bot.callbackQuery(/^pe:(\d+|d)$/, async (ctx) => {
      const id = ctx.match[1] === "d" ? null : Number(ctx.match[1])
      if (id !== null && !store.persona(id)) return void (await ctx.answerCallbackQuery({ text: "That persona no longer exists." }))
      store.updatePerson(ctx.from.id, { personaId: id })
      const v = personaView(ctx.from.id)
      await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.kb }).catch(() => {})
      await ctx.answerCallbackQuery({ text: "Applies from your next message" })
    })

    bot.command("memory", async (ctx) => {
      if (!ctx.from) return
      const v = memoryView(ctx.from.id)
      await ctx.reply(v.text, { parse_mode: "HTML", reply_markup: v.kb })
    })

    bot.callbackQuery(/^mm:(off|explicit|auto)$/, async (ctx) => {
      store.updatePerson(ctx.from.id, { memoryMode: ctx.match[1] as MemoryMode })
      await refresh(ctx, memoryView(ctx.from.id))
      await ctx.answerCallbackQuery()
    })

    bot.callbackQuery("mf:ask", async (ctx) => {
      const n = store.memories(ctx.from.id).length
      const kb = new InlineKeyboard().text(`Yes, forget all ${n}`, "mf:yes").text("Cancel", "mf:no")
      await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {})
      await ctx.answerCallbackQuery()
    })

    bot.callbackQuery(/^mf:(yes|no)$/, async (ctx) => {
      if (ctx.match[1] === "yes") {
        const n = store.clearMemories(ctx.from.id)
        await ctx.answerCallbackQuery({ text: `Forgot ${n} memor${n === 1 ? "y" : "ies"}` })
      } else await ctx.answerCallbackQuery()
      await refresh(ctx, memoryView(ctx.from.id))
    })

    bot.command("forget", async (ctx) => {
      if (!ctx.from) return
      const arg = ctx.match.trim().replace(/^#/, "")
      if (!/^\d+$/.test(arg)) return void (await ctx.reply("Send /forget followed by a memory number, e.g. /forget 12. /memory lists them."))
      const m = store.memory(Number(arg))
      if (!m || m.userId !== ctx.from.id) return void (await ctx.reply(`I have no memory #${arg} about you.`))
      store.deleteMemory(m.id)
      await ctx.reply(`🗑 Forgot: <i>${escape(truncate(m.text, 300))}</i>`, { parse_mode: "HTML" })
    })
  }
}

async function refresh(ctx: Context, v: { text: string; kb: InlineKeyboard }) {
  await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.kb }).catch(() => {})
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
