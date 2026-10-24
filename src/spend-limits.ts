import type { Config } from "./config"
import type { SessionEvent } from "./opencode"
import { formatTime, zonedTime } from "./schedule-spec"
import type { ChatKey, Store } from "./store"
import type { Usage } from "./usage"

export type Period = "day" | "month"

/** Share of a limit at which the person gets a heads-up. */
export const WARN_AT = 0.8

export interface PeriodSpend {
  period: Period
  spent: number
  /** `null` when there is no limit for this period. */
  limit: number | null
  from: number
  resetsAt: number
}

export interface PersonSpend {
  userId: number
  exempt: boolean
  day: PeriodSpend
  month: PeriodSpend
}

export interface Limits {
  daily: number | null
  monthly: number | null
  exempt: boolean
}

interface Deps {
  config: Pick<Config, "SCHEDULE_TIMEZONE" | "SPEND_LIMIT_DAILY" | "SPEND_LIMIT_MONTHLY">
  store: Pick<Store, "person" | "bySession">
  usage: Pick<Usage, "ready" | "observe" | "owner" | "spentBy">
  bridge: { interrupt: (sessionID: string) => Promise<unknown> }
  /** Post a message in a thread, or a chat's main view when `key.threadId` is 0. */
  send: (key: ChatKey, html: string) => Promise<void>
  now?: () => number
}

/** Raised when someone tries to start work past their limit; the message is meant for them. */
export class SpendLimitError extends Error {}

/** The current day and month in `tz`, and when each ends. */
export function periods(now: number, tz: string): Record<Period, { from: number; resetsAt: number }> {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value)
  const [y, m, d] = [get("year"), get("month"), get("day")]
  const midnight = (year: number, month: number, day: number) => {
    // Normalise overflow such as day 32 or month 13.
    const date = new Date(Date.UTC(year, month - 1, day))
    try {
      return zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, 0, tz)
    } catch {
      return date.getTime()
    }
  }
  return {
    day: { from: midnight(y, m, d), resetsAt: midnight(y, m, d + 1) },
    month: { from: midnight(y, m, 1), resetsAt: midnight(y, m + 1, 1) },
  }
}

export function usd(v: number): string {
  if (v === 0) return "$0.00"
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

/**
 * Per-person spending limits. New work is refused once someone is at a limit, and work already running for
 * them is stopped when a model call takes them over it. They get a heads-up at 80%.
 */
export class SpendLimits {
  private warned = new Set<string>()
  private stopped = new Map<string, number>()

  constructor(private readonly d: Deps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  limits(userId: number): Limits {
    const p = this.d.store.person(userId)
    if (p?.spendExempt) return { daily: null, monthly: null, exempt: true }
    return {
      daily: p?.spendDaily ?? this.d.config.SPEND_LIMIT_DAILY ?? null,
      monthly: p?.spendMonthly ?? this.d.config.SPEND_LIMIT_MONTHLY ?? null,
      exempt: false,
    }
  }

  /** What someone has spent today and this month, against their limits. */
  async spend(userId: number): Promise<PersonSpend> {
    await this.d.usage.ready()
    return this.measure(userId, this.limits(userId))
  }

  private measure(userId: number, limits: Limits): PersonSpend {
    const p = periods(this.now(), this.d.config.SCHEDULE_TIMEZONE)
    const of = (period: Period, limit: number | null): PeriodSpend => ({ period, spent: this.d.usage.spentBy(userId, p[period].from), limit, ...p[period] })
    return { userId, exempt: limits.exempt, day: of("day", limits.daily), month: of("month", limits.monthly) }
  }

  /** The period someone has used up, if any. */
  async reached(userId: number): Promise<PeriodSpend | undefined> {
    const limits = this.limits(userId)
    if (limits.daily === null && limits.monthly === null) return undefined
    try {
      return over(await this.spend(userId))
    } catch (err) {
      // Spend can't be read while OpenCode is down, and then nothing can be spent either.
      console.error("Couldn't check spending limits", err)
      return undefined
    }
  }

  /** Throws a SpendLimitError, worded for the person, when they can't start anything new. */
  async check(userId: number): Promise<void> {
    const hit = await this.reached(userId)
    if (hit) throw new SpendLimitError(this.blockedText(hit))
  }

  blockedText(hit: PeriodSpend): string {
    const what = hit.period === "day" ? "today's" : "this month's"
    return `⛔ You've reached ${what} spending limit of ${usd(hit.limit!)}. It resets ${formatTime(hit.resetsAt, this.d.config.SCHEDULE_TIMEZONE, this.now())}.`
  }

  /** Feed every session event through here; finished model calls are counted and checked against limits. */
  async onEvent(e: SessionEvent): Promise<void> {
    if (e.type !== "session.step.ended") return
    const { sessionID, cost } = e.data
    await this.d.usage.observe(sessionID, e.created, cost)
    if (!cost) return
    const owner = this.d.usage.owner(sessionID)
    if (!owner?.userId) return
    const limits = this.limits(owner.userId)
    if (limits.daily === null && limits.monthly === null) return
    const spend = await this.spend(owner.userId)
    const where = this.d.store.bySession(owner.root) ?? { chatId: owner.userId, threadId: 0 }
    const hit = over(spend)
    if (hit) return this.stop(owner.root, sessionID, where, hit)
    for (const p of [spend.day, spend.month]) {
      if (p.limit === null || p.spent < p.limit * WARN_AT) continue
      const key = `${owner.userId}:${p.period}:${p.from}`
      if (this.warned.has(key)) continue
      this.warned.add(key)
      const what = p.period === "day" ? "today's" : "this month's"
      await this.d.send(where, `⚠️ You've used ${usd(p.spent)} of ${what} ${usd(p.limit)} spending limit.`).catch((err) => console.error("Couldn't send the spending warning", err))
    }
  }

  private async stop(root: string, sessionID: string, where: ChatKey, hit: PeriodSpend): Promise<void> {
    // Calls already in flight finish after the stop; tell the person once.
    const last = this.stopped.get(root)
    if (last && this.now() - last < 60_000) return
    this.stopped.set(root, this.now())
    await this.d.bridge.interrupt(root).catch((err) => console.error(`Couldn't stop ${root} at the spending limit`, err))
    if (sessionID !== root) await this.d.bridge.interrupt(sessionID).catch(() => {})
    await this.d.send(where, `${this.blockedText(hit)} I stopped here.`).catch((err) => console.error("Couldn't send the spending limit notice", err))
  }
}

/** The first period whose limit is used up. */
export function over(spend: PersonSpend): PeriodSpend | undefined {
  return [spend.day, spend.month].find((p) => p.limit !== null && p.spent >= p.limit)
}
