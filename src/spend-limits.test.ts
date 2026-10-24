import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "./opencode"
import { over, periods, SpendLimitError, SpendLimits, type PersonSpend } from "./spend-limits"
import type { ChatKey, Person } from "./store"
import type { Owner } from "./usage"

const TZ = "Europe/Amsterdam"
// Sat 24 Oct 2026, 15:30 in Amsterdam (summer time, UTC+2).
const NOW = Date.UTC(2026, 9, 24, 13, 30)

describe("periods", () => {
  test("starts the day and month at local midnight", () => {
    const p = periods(NOW, TZ)
    expect(new Date(p.day.from).toISOString()).toBe("2026-10-23T22:00:00.000Z")
    expect(new Date(p.day.resetsAt).toISOString()).toBe("2026-10-24T22:00:00.000Z")
    expect(new Date(p.month.from).toISOString()).toBe("2026-09-30T22:00:00.000Z")
    // Winter time starts on 25 October, so November begins at UTC+1.
    expect(new Date(p.month.resetsAt).toISOString()).toBe("2026-10-31T23:00:00.000Z")
  })

  test("rolls over the year", () => {
    const p = periods(Date.UTC(2026, 11, 31, 12), TZ)
    expect(new Date(p.day.resetsAt).toISOString()).toBe("2026-12-31T23:00:00.000Z")
    expect(new Date(p.month.resetsAt).toISOString()).toBe("2026-12-31T23:00:00.000Z")
  })
})

function setup(opts: { person?: Partial<Person>; daily?: number; monthly?: number; spent?: number; owner?: Partial<Owner> | null } = {}) {
  let spent = opts.spent ?? 0
  const sent: { key: ChatKey; html: string }[] = []
  const interrupted: string[] = []
  const owner: Owner | null = opts.owner === null ? null : { root: "root", source: "conversation", userId: 1, schedule: null, bound: true, ...opts.owner }
  const limits = new SpendLimits({
    config: { SCHEDULE_TIMEZONE: TZ, SPEND_LIMIT_DAILY: opts.daily, SPEND_LIMIT_MONTHLY: opts.monthly },
    store: {
      person: (id) => (opts.person ? ({ id, name: null, username: null, personaId: null, memoryMode: null, seenAt: null, spendDaily: null, spendMonthly: null, spendExempt: false, ...opts.person } as Person) : undefined),
      bySession: (id) => (id === "root" ? { chatId: 1, threadId: 9, sessionID: "root", userId: 1, autoTitle: false, updatedAt: 0 } : undefined),
    },
    usage: {
      ready: async () => {},
      observe: async (_id, _at, cost) => void (spent += cost),
      owner: () => owner,
      spentBy: () => spent,
    },
    bridge: { interrupt: async (id: string) => void interrupted.push(id) },
    send: async (key, html) => void sent.push({ key, html }),
    now: () => NOW,
  })
  const step = (cost: number, sessionID = "root") =>
    limits.onEvent({ type: "session.step.ended", created: NOW, data: { sessionID, cost, tokens: {} } } as unknown as SessionEvent)
  return { limits, sent, interrupted, step }
}

describe("SpendLimits", () => {
  test("a person's own limits win over the defaults, and exempt means none", () => {
    expect(setup({ daily: 5, monthly: 50 }).limits.limits(1)).toEqual({ daily: 5, monthly: 50, exempt: false })
    expect(setup({ daily: 5, monthly: 50, person: { spendDaily: 2 } }).limits.limits(1)).toEqual({ daily: 2, monthly: 50, exempt: false })
    expect(setup({ daily: 5, person: { spendExempt: true, spendDaily: 2 } }).limits.limits(1)).toEqual({ daily: null, monthly: null, exempt: true })
  })

  test("refuses new work at the limit", async () => {
    await setup({ daily: 5, spent: 4.99 }).limits.check(1)
    const err = await setup({ daily: 5, spent: 5 }).limits.check(1).catch((e) => e)
    expect(err).toBeInstanceOf(SpendLimitError)
    expect(err.message).toContain("today's spending limit of $5.00")
    expect(err.message).toContain("Sun 25 Oct 00:00")
  })

  test("never blocks without limits", async () => {
    await setup({ spent: 1000 }).limits.check(1)
  })

  test("warns once at 80% and stops the run at the limit", async () => {
    const { sent, interrupted, step } = setup({ daily: 5, spent: 3.9 })
    await step(0.05)
    expect(sent).toHaveLength(0)
    await step(0.1)
    await step(0.1)
    expect(sent.map((s) => s.html)).toEqual(["⚠️ You've used $4.05 of today's $5.00 spending limit."])
    expect(sent[0]!.key).toMatchObject({ chatId: 1, threadId: 9 })
    await step(1, "child")
    await step(0.2, "child")
    expect(interrupted).toEqual(["root", "child"])
    expect(sent).toHaveLength(2)
    expect(sent[1]!.html).toContain("I stopped here.")
  })

  test("ignores spend nobody owns", async () => {
    const { sent, interrupted, step } = setup({ daily: 1, spent: 5, owner: { userId: null } })
    await step(1)
    expect(sent).toHaveLength(0)
    expect(interrupted).toHaveLength(0)
  })
})

test("over picks the period that is used up", () => {
  const p = (spent: number, limit: number | null) => ({ period: "day" as const, spent, limit, from: 0, resetsAt: 0 })
  const spend: PersonSpend = { userId: 1, exempt: false, day: p(1, 5), month: { ...p(60, 50), period: "month" } }
  expect(over(spend)?.period).toBe("month")
  expect(over({ ...spend, month: { ...spend.month, limit: null } })).toBeUndefined()
})
