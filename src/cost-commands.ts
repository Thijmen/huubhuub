import type { Bot } from "grammy"
import { keyOf, type Chats } from "./chats"
import { formatTime } from "./schedule-spec"
import { usd, type PeriodSpend, type PersonSpend, type SpendLimits } from "./spend-limits"
import type { SessionTotals, Usage } from "./usage"

/** `/costs`: what the conversation in this thread has cost, and what the sender has spent against their limits. */
export function costCommands(deps: { usage: Usage; limits: SpendLimits; timeZone: () => string }) {
  const { usage, limits, timeZone } = deps
  return (bot: Bot, chats: Chats) => {
    bot.command("costs", async (ctx) => {
      const sessionID = chats.sessionIn(keyOf(ctx))
      // A slightly older scan is fine; calls since then are counted live.
      await usage.sync(5_000)
      const totals = sessionID ? usage.totals(sessionID) : undefined
      const spend = ctx.from ? await limits.spend(ctx.from.id) : undefined
      await ctx.reply(costsText(totals, spend, timeZone()), { parse_mode: "HTML" })
    })
  }
}

export function costsText(totals: SessionTotals | undefined, spend: PersonSpend | undefined, tz: string, now = Date.now()): string {
  const lines: string[] = ["💰 <b>This conversation</b>"]
  if (!totals || totals.turns === 0) lines.push("Nothing spent here yet.")
  else {
    const t = totals.tokens
    const used = t.input + t.output + t.reasoning
    lines.push(`<b>${usd(totals.cost)}</b> · ${totals.turns} model call${totals.turns === 1 ? "" : "s"} · ${tokens(used)} tokens${t.cacheRead ? ` (+${tokens(t.cacheRead)} from cache)` : ""}`)
    if (totals.models.length > 1 || (totals.models.length === 1 && totals.subagents)) {
      for (const m of totals.models.slice(0, 6)) lines.push(`• ${escape(m.model.slice(m.model.indexOf("/") + 1))}: ${usd(m.cost)}`)
    } else if (totals.models[0]) lines.push(`Model: ${escape(totals.models[0].model)}`)
    if (totals.subagents) lines.push(`<i>Includes ${totals.subagents} subagent session${totals.subagents === 1 ? "" : "s"}.</i>`)
  }
  if (spend) {
    lines.push("", "👤 <b>Your spending</b>")
    lines.push(periodLine("Today", spend.day, tz, now), periodLine("This month", spend.month, tz, now))
    if (spend.exempt) lines.push("<i>No spending limits apply to you.</i>")
    else if (spend.day.limit === null && spend.month.limit === null) lines.push("<i>No spending limits are set.</i>")
  }
  return lines.join("\n")
}

function periodLine(label: string, p: PeriodSpend, tz: string, now: number): string {
  if (p.limit === null) return `${label}: ${usd(p.spent)}`
  const share = Math.round((p.spent / p.limit) * 100)
  const reached = p.spent >= p.limit ? " ⛔" : share >= 80 ? " ⚠️" : ""
  return `${label}: ${usd(p.spent)} of ${usd(p.limit)} (${share}%)${reached} · resets ${formatTime(p.resetsAt, tz, now)}`
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
