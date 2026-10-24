import { describe, expect, test } from "bun:test"
import type { UsageReport, UsageRow, UsageSession } from "./api"
import { OTHER_COLOR, rangeWindow, SERIES_COLORS, seriesFor, spend, ticks } from "./spend"

const HOUR = 3_600_000
const now = new Date(2026, 9, 24, 15, 30).getTime()

function session(id: string, over: Partial<UsageSession> = {}): UsageSession {
  return { id, title: id, source: "conversation", userId: 1, schedule: null, open: id, parentID: null, cost: 0, created: 0, updated: 0, ...over }
}

function row(t: number, s: number, m: number, cost: number, turns = 1): UsageRow {
  return [t, s, m, cost, 100, 50, 0, 10, 0, turns]
}

const report: UsageReport = {
  generatedAt: now,
  sessions: [session("a"), session("b", { source: "schedule", userId: null, schedule: "Daily digest" })],
  models: ["anthropic/claude-opus-5-5", "openai/gpt-6"],
  people: [{ id: 1, name: "Thijmen" }],
  rows: [
    row(now - 70 * 24 * HOUR, 0, 0, 5), // before both periods
    row(now - 35 * 24 * HOUR, 0, 0, 1), // previous 30-day period
    row(now - 2 * 24 * HOUR, 0, 0, 2),
    row(now - 2 * 24 * HOUR, 1, 1, 0.5),
    row(now - HOUR, 0, 1, 0.25, 3),
  ],
}

describe("spend", () => {
  test("sums the range into daily buckets", () => {
    const s = spend(report, "30d", "model", now)
    expect(s.step).toBe("day")
    expect(s.buckets).toHaveLength(30)
    expect(s.cost).toBeCloseTo(2.75)
    expect(s.turns).toBe(5)
    expect(s.previous).toBeCloseTo(1)
    expect(s.buckets.reduce((sum, b) => sum + b.total, 0)).toBeCloseTo(2.75)
    expect(s.buckets.at(-1)!.total).toBeCloseTo(0.25)
  })

  test("splits by source and person", () => {
    const bySource = spend(report, "7d", "source", now)
    expect(bySource.breakdown.source.map((r) => [r.label, r.cost])).toEqual([
      ["Conversations", 2.25],
      ["Scheduled tasks", 0.5],
    ])
    expect(bySource.breakdown.person.map((r) => r.label)).toEqual(["Thijmen", "Background"])
  })

  test("ranks sessions and picks their main model", () => {
    const s = spend(report, "7d", "model", now)
    expect(s.sessions.map((x) => [x.session.id, x.model])).toEqual([
      ["a", "anthropic/claude-opus-5-5"],
      ["b", "openai/gpt-6"],
    ])
  })

  test("uses hours for 24h and has no previous total for all time", () => {
    expect(spend(report, "24h", "model", now).buckets).toHaveLength(24)
    expect(spend(report, "all", "model", now).previous).toBeNull()
  })

  test("weeks for long histories", () => {
    expect(rangeWindow("all", now, now - 200 * 24 * HOUR).step).toBe("week")
    expect(rangeWindow("all", now, now - 20 * 24 * HOUR).step).toBe("day")
  })
})

describe("seriesFor", () => {
  test("keeps colours in all-time order and folds the tail into Other", () => {
    const models = Array.from({ length: 10 }, (_, i) => `p/m${i}`)
    const many: UsageReport = { ...report, models, rows: models.map((_, i) => row(now, 0, i, 10 - i)) }
    const { series, index } = seriesFor(many, "model")
    expect(series).toHaveLength(SERIES_COLORS.length)
    expect(series[0]!.label).toBe("m0")
    expect(series.at(-1)!.color).toBe(OTHER_COLOR)
    expect(index(many.rows[9]!)).toBe(series.length - 1)
  })
})

test("ticks are round and cover the max", () => {
  expect(ticks(9.3)).toEqual([0, 2.5, 5, 7.5, 10])
  expect(ticks(0)).toEqual([0])
})
