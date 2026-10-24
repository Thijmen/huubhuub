import type { UsageReport, UsageRow, UsageSession, UsageSource } from "./api"

export type Range = "24h" | "7d" | "30d" | "90d" | "all"
export type Split = "model" | "source" | "person"
export type Step = "hour" | "day" | "week"

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Categorical slots, stepped for the dark surface; validated in this order. A ninth series folds into "Other". */
export const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"]
export const OTHER_COLOR = "#6b7183"

export const SOURCE_LABELS: Record<UsageSource, string> = {
  conversation: "Conversations",
  schedule: "Scheduled tasks",
  memory: "Memory reviews",
  other: "Other sessions",
}

export interface Series {
  key: string
  label: string
  color: string
}

export interface Bucket {
  start: number
  end: number
  /** Spend per series, in `series` order. */
  values: number[]
  total: number
}

export interface SessionSpend {
  session: UsageSession
  cost: number
  turns: number
  tokens: number
  /** The model this session spent the most on. */
  model: string
}

export interface Spend {
  from: number
  to: number
  step: Step
  series: Series[]
  buckets: Bucket[]
  cost: number
  turns: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  /** Spend in the period of the same length just before this one; null for "all". */
  previous: number | null
  /** Spend per key, for every split, highest first. */
  breakdown: Record<Split, { key: string; label: string; color: string; cost: number }[]>
  sessions: SessionSpend[]
}

export function floorTo(t: number, step: Step): number {
  const d = new Date(t)
  if (step === "hour") return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime()
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (step === "day") return day.getTime()
  // Weeks start on Monday.
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day.getTime()
}

export function addStep(t: number, step: Step): number {
  const d = new Date(t)
  if (step === "hour") return t + HOUR
  d.setDate(d.getDate() + (step === "day" ? 1 : 7))
  return d.getTime()
}

/** The window a range covers, ending now, and the bucket size that fits it. */
export function rangeWindow(range: Range, now: number, first: number | undefined): { from: number; to: number; step: Step } {
  if (range === "24h") return { from: floorTo(now - 23 * HOUR, "hour"), to: now, step: "hour" }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : null
  if (days) return { from: floorTo(now - (days - 1) * DAY, "day"), to: now, step: "day" }
  const start = first ?? now
  const step: Step = now - start > 120 * DAY ? "week" : "day"
  // At least a week of days, so a young bot still gets a readable chart.
  return { from: Math.min(floorTo(start, step), floorTo(now - 6 * DAY, "day")), to: now, step }
}

/** Who or what a row's spend belongs to, for one split. */
function keyOf(split: Split, report: UsageReport, row: UsageRow): { key: string; label: string } {
  const session = report.sessions[row[1]]!
  if (split === "model") {
    const model = report.models[row[2]]!
    return { key: model, label: model.slice(model.indexOf("/") + 1) || model }
  }
  if (split === "source") return { key: session.source, label: SOURCE_LABELS[session.source] }
  if (session.userId === null) return { key: "none", label: session.source === "conversation" ? "Unknown person" : "Background" }
  const name = report.people.find((p) => p.id === session.userId)?.name ?? String(session.userId)
  return { key: `user:${session.userId}`, label: name }
}

/**
 * Colours follow the entity, not its rank in the current range: the slots go to the biggest spenders of all
 * time, so changing the range never repaints a series.
 */
export function seriesFor(report: UsageReport, split: Split): { series: Series[]; index: (row: UsageRow) => number } {
  const totals = new Map<string, { label: string; cost: number }>()
  for (const row of report.rows) {
    const { key, label } = keyOf(split, report, row)
    const t = totals.get(key) ?? { label, cost: 0 }
    t.cost += row[3]
    totals.set(key, t)
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1].cost - a[1].cost || a[1].label.localeCompare(b[1].label))
  // Eight or fewer fit; past that the tail folds into "Other" so no hue is ever generated.
  const named = ranked.length <= SERIES_COLORS.length ? ranked : ranked.slice(0, SERIES_COLORS.length - 1)
  const series: Series[] = named.map(([key, t], i) => ({ key, label: t.label, color: SERIES_COLORS[i]! }))
  const hasOther = named.length < ranked.length
  if (hasOther) series.push({ key: "__other", label: `${ranked.length - named.length} more`, color: OTHER_COLOR })
  const position = new Map(series.map((s, i) => [s.key, i]))
  return { series, index: (row) => position.get(keyOf(split, report, row).key) ?? series.length - 1 }
}

export function spend(report: UsageReport, range: Range, split: Split, now = Date.now()): Spend {
  const { from, to, step } = rangeWindow(range, now, report.rows[0]?.[0])
  const { series, index } = seriesFor(report, split)

  const buckets: Bucket[] = []
  for (let t = from; t <= to; t = addStep(t, step)) buckets.push({ start: t, end: addStep(t, step), values: series.map(() => 0), total: 0 })
  const bucketAt = (t: number) => {
    // Buckets are contiguous and few; a binary search keeps a long history quick.
    let lo = 0
    let hi = buckets.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const b = buckets[mid]!
      if (t < b.start) hi = mid - 1
      else if (t >= b.end) lo = mid + 1
      else return b
    }
    return undefined
  }

  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  const per: Record<Split, Map<string, { key: string; label: string; cost: number }>> = { model: new Map(), source: new Map(), person: new Map() }
  const sessions = new Map<number, SessionSpend & { models: Map<string, number> }>()
  let cost = 0
  let turns = 0
  let previous = 0
  const span = to - from

  for (const row of report.rows) {
    const [t, s, m, c] = row
    if (t >= from - span && t < from) previous += c
    if (t < from || t > to) continue
    const b = bucketAt(t)
    if (!b) continue
    const i = index(row)
    b.values[i]! += c
    b.total += c
    cost += c
    turns += row[9]
    tokens.input += row[4]
    tokens.output += row[5]
    tokens.reasoning += row[6]
    tokens.cacheRead += row[7]
    tokens.cacheWrite += row[8]
    for (const split of ["model", "source", "person"] as const) {
      const { key, label } = keyOf(split, report, row)
      const e = per[split].get(key) ?? { key, label, cost: 0 }
      e.cost += c
      per[split].set(key, e)
    }
    const entry = sessions.get(s) ?? { session: report.sessions[s]!, cost: 0, turns: 0, tokens: 0, model: "", models: new Map<string, number>() }
    entry.cost += c
    entry.turns += row[9]
    entry.tokens += row[4] + row[5] + row[6]
    const model = report.models[m]!
    entry.models.set(model, (entry.models.get(model) ?? 0) + c)
    sessions.set(s, entry)
  }

  const breakdown = Object.fromEntries(
    (["model", "source", "person"] as const).map((split) => {
      const colors = new Map(seriesFor(report, split).series.map((s) => [s.key, s.color]))
      const rows = [...per[split].values()]
        .sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label))
        .map((e) => ({ ...e, color: colors.get(e.key) ?? OTHER_COLOR }))
      return [split, rows]
    }),
  ) as Spend["breakdown"]

  return {
    from,
    to,
    step,
    series,
    buckets,
    cost,
    turns,
    tokens,
    previous: range === "all" ? null : previous,
    breakdown,
    sessions: [...sessions.values()]
      .map(({ models, ...e }) => ({ ...e, model: [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "" }))
      .sort((a, b) => b.cost - a.cost),
  }
}

export function money(v: number): string {
  if (v === 0) return "$0.00"
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  if (v < 1000) return `$${v.toFixed(2)}`
  return `$${Math.round(v).toLocaleString("en-US")}`
}

export function tokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Round axis ticks from zero to just above `max`. */
export function ticks(max: number, count = 4): number[] {
  if (max <= 0) return [0]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!
  const out: number[] = []
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Number(v.toPrecision(12)))
  return out
}
