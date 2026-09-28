import { InlineKeyboard, type Bot, type Context } from "grammy"
import type { Chats } from "./chats"
import { keyOf } from "./chats"
import type { Bridge } from "./opencode"
import { threadParams } from "./reply"
import { defaultName, describe, firstRun, formatTime, parseInput, SpecError, USAGE, type Parsed } from "./schedule-spec"
import type { Scheduler } from "./scheduler"
import type { Schedule, Store } from "./store"

const DRAFT_TTL_MS = 30 * 60_000
const NAME_MAX = 80

interface Draft {
  chatId: number
  parsed: Parsed
  model: string | null
  agent: string | null
  silent: boolean
  created: number
}

/** `/schedule`, `/schedules` and their buttons. */
export function scheduleCommands(deps: { bridge: Bridge; store: Store; scheduler: Scheduler; timeZone: () => string }) {
  const { bridge, store, scheduler, timeZone } = deps
  const drafts = new Map<string, Draft>()
  /** `chatId:userId` → schedule being renamed. */
  const renaming = new Map<string, number>()

  const sweep = (now: number) => {
    for (const [id, d] of drafts) if (now - d.created > DRAFT_TTL_MS) drafts.delete(id)
  }

  return (bot: Bot, chats: Chats) => {
    bot.command("schedule", async (ctx) => {
      const input = ctx.match.trim()
      if (!input) return void (await ctx.reply(USAGE, { parse_mode: "HTML" }))
      const now = Date.now()
      let parsed: Parsed
      try {
        parsed = parseInput(input, now, timeZone())
      } catch (err) {
        if (!(err instanceof SpecError)) throw err
        return void (await ctx.reply(`⚠️ ${escape(err.message)}\n\n${USAGE}`, { parse_mode: "HTML" }))
      }
      const sessionID = chats.sessionIn(keyOf(ctx))
      const selection = sessionID ? await bridge.selection(sessionID).catch(() => ({ model: null, agent: null })) : { model: null, agent: null }
      sweep(now)
      const id = Bun.hash(`${ctx.chat.id}:${now}:${input}`).toString(36)
      const draft: Draft = { chatId: ctx.chat.id, parsed, ...selection, silent: false, created: now }
      drafts.set(id, draft)
      await ctx.reply(draftText(draft, timeZone()), { parse_mode: "HTML", reply_markup: draftKeyboard(id, draft) })
    })

    bot.callbackQuery(/^sc:([a-z0-9]+):([ynq])$/, async (ctx) => {
      const [, id, action] = ctx.match
      const draft = drafts.get(id!)
      if (!draft) {
        await ctx.editMessageReplyMarkup().catch(() => {})
        return void (await ctx.answerCallbackQuery({ text: "This draft expired. Send /schedule again." }))
      }
      if (action === "q") {
        draft.silent = !draft.silent
        await ctx.editMessageText(draftText(draft, timeZone()), { parse_mode: "HTML", reply_markup: draftKeyboard(id!, draft) })
        return void (await ctx.answerCallbackQuery())
      }
      drafts.delete(id!)
      if (action === "n") {
        await ctx.editMessageText("✖ Not scheduled.")
        return void (await ctx.answerCallbackQuery())
      }
      const p = draft.parsed
      // Recurring jobs count from the moment they're confirmed, not from when the draft was made.
      const nextAt = firstRun(p, Date.now(), timeZone())
      const s = store.createSchedule({
        chatId: draft.chatId,
        name: defaultName(p.prompt),
        kind: p.kind,
        spec: p.spec,
        prompt: p.prompt,
        model: draft.model,
        agent: draft.agent,
        silent: draft.silent,
        nextAt,
      })
      scheduler.refresh()
      await ctx.editMessageText(
        `✅ Scheduled <b>${escape(s.name)}</b>\n${escape(describe(s, timeZone()))} · next ${escape(formatTime(nextAt, timeZone()))}\n\nManage it with /schedules.`,
        { parse_mode: "HTML" },
      )
      await ctx.answerCallbackQuery({ text: "Scheduled" })
    })

    bot.command("schedules", async (ctx) => {
      await ctx.reply(listText(store.schedules(ctx.chat.id), scheduler, timeZone()), { parse_mode: "HTML", reply_markup: listKeyboard(store.schedules(ctx.chat.id)) })
    })

    const refresh = async (ctx: Context) => {
      const list = store.schedules(ctx.chat!.id)
      await ctx.editMessageText(listText(list, scheduler, timeZone()), { parse_mode: "HTML", reply_markup: listKeyboard(list) }).catch((err) => {
        if (!String(err).includes("message is not modified")) throw err
      })
    }

    bot.callbackQuery(/^sj:(\d+):(pause|run|ren|del|delok|back)$/, async (ctx) => {
      const id = Number(ctx.match[1])
      const action = ctx.match[2]!
      const s = store.schedule(id)
      if (!s || s.chatId !== ctx.chat?.id) {
        await refresh(ctx)
        return void (await ctx.answerCallbackQuery({ text: "That schedule no longer exists." }))
      }
      switch (action) {
        case "pause": {
          const paused = !s.paused
          store.updateSchedule(id, { paused, ...(paused ? {} : { failStreak: 0 }) })
          if (!paused) scheduler.reschedule(id)
          await refresh(ctx)
          return void (await ctx.answerCallbackQuery({ text: paused ? "Paused" : "Resumed" }))
        }
        case "run":
          try {
            scheduler.runNow(id)
          } catch (err) {
            if (!(err instanceof SpecError)) throw err
            return void (await ctx.answerCallbackQuery({ text: err.message }))
          }
          await refresh(ctx)
          return void (await ctx.answerCallbackQuery({ text: "Started" }))
        case "ren":
          renaming.set(`${ctx.chat.id}:${ctx.from.id}`, id)
          await ctx.reply(`✏️ Send the new name for <b>${escape(s.name)}</b>.`, {
            parse_mode: "HTML",
            reply_markup: { force_reply: true, input_field_placeholder: s.name },
            ...threadParams(keyOf(ctx)),
          })
          return void (await ctx.answerCallbackQuery())
        case "del":
          await ctx.editMessageReplyMarkup({
            reply_markup: new InlineKeyboard().text(`🗑 Delete "${clip(s.name, 30)}"`, `sj:${id}:delok`).text("↩ Keep", `sj:${id}:back`),
          })
          return void (await ctx.answerCallbackQuery())
        case "delok":
          store.deleteSchedule(id)
          scheduler.refresh()
          await refresh(ctx)
          return void (await ctx.answerCallbackQuery({ text: "Deleted" }))
        case "back":
          await refresh(ctx)
          return void (await ctx.answerCallbackQuery())
      }
    })

    bot.on("message:text", async (ctx, next) => {
      const slot = `${ctx.chat.id}:${ctx.from.id}`
      const id = renaming.get(slot)
      if (id === undefined || ctx.message.text.startsWith("/")) return next()
      renaming.delete(slot)
      const name = ctx.message.text.replace(/\s+/g, " ").trim().slice(0, NAME_MAX)
      const s = store.schedule(id)
      if (!s || !name) return void (await ctx.reply("Nothing renamed."))
      store.updateSchedule(id, { name })
      await ctx.reply(`✏️ Renamed to <b>${escape(name)}</b>.`, { parse_mode: "HTML" })
    })
  }
}

function draftText(d: Draft, tz: string): string {
  const p = d.parsed
  return [
    "⏰ <b>Schedule this?</b>",
    "",
    `<b>When</b> ${escape(describe(p, tz))}`,
    `<b>Next run</b> ${escape(formatTime(p.nextAt, tz))}`,
    `<b>Prompt</b> ${escape(clip(p.prompt, 800))}`,
    `<b>Model</b> ${escape(d.model ?? "default")} · <b>Agent</b> ${escape(d.agent ?? "default")}`,
    `<b>Silent</b> ${d.silent ? `on: only posts if there's something to report` : "off"}`,
  ].join("\n")
}

function draftKeyboard(id: string, d: Draft): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Schedule", `sc:${id}:y`)
    .text("✖ Cancel", `sc:${id}:n`)
    .row()
    .text(d.silent ? "🔕 Silent: on" : "🔔 Silent: off", `sc:${id}:q`)
}

export function listText(list: Schedule[], scheduler: Scheduler, tz: string): string {
  if (!list.length) return `⏰ No scheduled prompts in this chat yet.\n\n${USAGE}`
  const lines = ["⏰ <b>Scheduled prompts</b>", ""]
  for (const s of list) {
    const state = scheduler.running(s.id) ? "▶️ running" : s.paused ? "⏸ paused" : s.nextAt ? `next ${formatTime(s.nextAt, tz)}` : "done"
    const flags = [s.silent ? "🔕" : "", s.failStreak ? `⚠️ ${s.failStreak} failed` : ""].filter(Boolean).join(" ")
    lines.push(`<b>${s.id}. ${escape(s.name)}</b> ${flags}`, `   ${escape(describe(s, tz))} · ${escape(state)}`)
  }
  return lines.join("\n")
}

function listKeyboard(list: Schedule[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const s of list) {
    kb.text(`${s.paused ? "▶ Resume" : "⏸ Pause"} ${s.id}`, `sj:${s.id}:pause`)
      .text(`⚡ Run ${s.id}`, `sj:${s.id}:run`)
      .text("✏️", `sj:${s.id}:ren`)
      .text("🗑", `sj:${s.id}:del`)
      .row()
  }
  return kb
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
