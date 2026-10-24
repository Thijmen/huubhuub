/** Parse what a user types after `/schedule` (or in the admin UI) and compute run times in a time zone. */

import type { ScheduleKind } from "./store"

export interface When {
  kind: ScheduleKind
  /** Cron expression or nickname, `every <n><m|h|d>`, or the ISO instant of a one-off job. */
  spec: string
}

export interface Parsed extends When {
  prompt: string
  nextAt: number
}

export class SpecError extends Error {}

export const USAGE = [
  "<b>/schedule</b> <i>when</i> <i>prompt</i>",
  "",
  "<i>when</i> is one of:",
  "• a cron expression: <code>0 8 * * 1-5</code>",
  "• <code>@hourly</code>, <code>@daily</code> or <code>@daily 08:30</code>",
  "• <code>every 30m</code>, <code>every 2h</code>",
  "• once: <code>in 2h</code>, <code>at 18:00</code> or <code>at 2026-10-01 09:00</code>",
  "",
  "Start the prompt with <code>$</code> to run a shell command in the workspace instead.",
  "",
  "Examples:",
  "<code>/schedule @daily 08:00 Summarise the open GitHub issues</code>",
  "<code>/schedule every 1h $ ./check-disk.sh</code>",
  "",
  "You can also just ask the agent to schedule something.",
].join("\n")

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const NAME_LENGTH = 40

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Split `/schedule` input into when + prompt. */
export function parseInput(input: string, now: number, tz: string): Parsed {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) throw new SpecError("Tell me when and what to run.")
  let failure: unknown
  for (const take of candidates(tokens)) {
    let when: When
    try {
      when = parseWhen(tokens.slice(0, take).join(" "), now, tz)
    } catch (err) {
      failure ??= err
      continue
    }
    const prompt = restAfter(input, take)
    if (!prompt) throw new SpecError("Add the prompt to run after the schedule.")
    return { ...when, prompt, nextAt: firstRun(when, now, tz) }
  }
  // Keyword-led input and cron-looking input deserve the specific error; anything else just didn't match.
  if (failure instanceof SpecError && (/^(@|every$|in$|at$)/i.test(tokens[0]!) || looksLikeCron(tokens))) throw failure
  throw new SpecError("I couldn't find a schedule at the start of that message.")
}

/** How many leading tokens could form the schedule, most specific first. */
function candidates(tokens: string[]): number[] {
  const first = tokens[0]!.toLowerCase()
  if (first === "@daily" && /^\d{1,2}:\d{2}$/.test(tokens[1] ?? "")) return [2]
  if (first.startsWith("@")) return [1]
  // "every 2h" or "every 2 hours".
  if (first === "every" || first === "in") return /^\d+$/.test(tokens[1] ?? "") ? [3] : [2]
  if (first === "at") return /^\d{4}-\d{2}-\d{2}$/.test(tokens[1] ?? "") ? [3] : [2]
  return [5]
}

function looksLikeCron(tokens: string[]): boolean {
  const head = tokens.slice(0, 5)
  return head.length === 5 && /^[\d*]/.test(head[0]!) && head.every((t) => /^[\d*,\-/A-Za-z?]+$/.test(t))
}

/** The original text after the first `n` whitespace-separated tokens, keeping the prompt's own line breaks. */
function restAfter(input: string, n: number): string {
  const re = /\S+/g
  let end = 0
  for (let i = 0; i < n; i++) {
    const m = re.exec(input)
    if (!m) return ""
    end = m.index + m[0].length
  }
  return input.slice(end).trim()
}

/** Parse just the "when" part. */
export function parseWhen(text: string, now: number, tz: string): When {
  const t = text.trim().replace(/\s+/g, " ")
  if (!t) throw new SpecError("Say when to run it.")
  const lower = t.toLowerCase()

  const daily = /^@daily (\d{1,2}):(\d{2})$/.exec(lower)
  if (daily) return { kind: "cron", spec: `${clock(daily[2]!, 59)} ${clock(daily[1]!, 23)} * * *` }

  const every = /^every (\d+) ?(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(lower)
  if (every) {
    const n = Number(every[1])
    if (n <= 0) throw new SpecError("The interval has to be at least 1 minute.")
    return { kind: "interval", spec: `every ${n}${every[2]![0]}` }
  }

  const inMatch = /^in (\d+) ?(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(lower)
  if (inMatch) {
    const n = Number(inMatch[1])
    if (n <= 0) throw new SpecError("Pick a time in the future.")
    return { kind: "once", spec: new Date(now + n * UNIT_MS[inMatch[2]![0] as keyof typeof UNIT_MS]).toISOString() }
  }

  const atDate = /^at (\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/.exec(lower)
  if (atDate) {
    const [, y, mo, d, h, mi] = atDate.map(Number) as number[]
    const at = zonedTime(y!, mo!, d!, h!, mi!, tz)
    if (at <= now) throw new SpecError("That time is in the past.")
    return { kind: "once", spec: new Date(at).toISOString() }
  }

  const atTime = /^at (\d{1,2}):(\d{2})$/.exec(lower)
  if (atTime) {
    const next = Bun.cron.parse(`${clock(atTime[2]!, 59)} ${clock(atTime[1]!, 23)} * * *`, now, { tz })
    return { kind: "once", spec: next!.toISOString() }
  }

  if (/^(in|at|every)\b/.test(lower)) throw new SpecError(`I don't understand "${t}". Try "every 30m", "in 2h" or "at 2026-10-01 09:00".`)

  if (t.startsWith("@") || t.split(" ").length === 5) {
    let next: Date | null
    try {
      next = Bun.cron.parse(t, now, { tz })
    } catch (err) {
      throw new SpecError(`That isn't a valid schedule: ${(err as Error).message.replace(/^Invalid cron expression: /, "")}.`)
    }
    if (!next) throw new SpecError("That schedule never runs.")
    return { kind: "cron", spec: t }
  }
  throw new SpecError(`I don't understand "${t}". Use a cron expression like "0 8 * * 1-5" or a shortcut like "@daily 08:00".`)
}

function clock(v: string, max: number): number {
  const n = Number(v)
  if (n > max) throw new SpecError(`${v} isn't a valid ${max === 23 ? "hour" : "minute"}.`)
  return n
}

/** Epoch ms for a wall-clock time in `tz`. Bun's cron handles the DST rules, including skipped hours. */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  if (h > 23 || mi > 59) throw new SpecError("That isn't a valid time.")
  const from = Date.UTC(y, mo - 1, d) - 2 * UNIT_MS.d
  const next = Bun.cron.parse(`${mi} ${h} ${d} ${mo} *`, from, { tz })
  if (!next || localParts(next.getTime(), tz).year !== y) throw new SpecError("That date doesn't exist.")
  return next.getTime()
}

export function intervalMs(spec: string): number {
  const m = /^every (\d+)([mhd])$/.exec(spec)
  if (!m) throw new SpecError(`Bad interval ${spec}`)
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]
}

/** When a new job first runs. */
export function firstRun(when: When, now: number, tz: string): number {
  if (when.kind === "once") return Date.parse(when.spec)
  if (when.kind === "interval") return now + intervalMs(when.spec)
  return cronNext(when.spec, now, tz)
}

/**
 * The first run strictly after `now` for a recurring job. Intervals stay anchored to their previous
 * slot so they don't drift; one-off jobs have no next run.
 */
export function nextRun(when: When, previous: number | null, now: number, tz: string): number | null {
  if (when.kind === "once") return null
  if (when.kind === "interval") {
    const step = intervalMs(when.spec)
    const base = previous ?? now
    if (base > now) return base
    return base + (Math.floor((now - base) / step) + 1) * step
  }
  return cronNext(when.spec, now, tz)
}

function cronNext(spec: string, after: number, tz: string): number {
  const next = Bun.cron.parse(spec, after, { tz })
  if (!next) throw new SpecError("That schedule never runs.")
  return next.getTime()
}

/** The next few run times, for previews. */
export function upcoming(when: When, now: number, tz: string, count = 3): number[] {
  const out: number[] = []
  let at: number | null = firstRun(when, now, tz)
  while (at !== null && out.length < count) {
    out.push(at)
    at = nextRun(when, at, at, tz)
  }
  return out
}

export function describe(when: When, tz: string): string {
  if (when.kind === "once") return `once, ${formatTime(Date.parse(when.spec), tz)}`
  if (when.kind === "interval") {
    const [, n, u] = /^every (\d+)([mhd])$/.exec(when.spec)!
    const unit = { m: "minute", h: "hour", d: "day" }[u as "m" | "h" | "d"]
    return n === "1" ? `every ${unit}` : `every ${n} ${unit}s`
  }
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(when.spec)
  if (daily) return `every day at ${pad(daily[2]!)}:${pad(daily[1]!)}`
  const nick: Record<string, string> = {
    "@hourly": "every hour",
    "@daily": "every day at 00:00",
    "@midnight": "every day at 00:00",
    "@weekly": "every Sunday at 00:00",
    "@monthly": "on the 1st of every month",
    "@yearly": "every 1 January",
    "@annually": "every 1 January",
  }
  return nick[when.spec.toLowerCase()] ?? `cron ${when.spec}`
}

export function defaultName(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim()
  return flat.length > NAME_LENGTH ? `${flat.slice(0, NAME_LENGTH - 1).trimEnd()}…` : flat
}

/** "Tue 29 Sep 08:00", with the year only when it isn't the current one. */
export function formatTime(ms: number, tz: string, now = Date.now()): string {
  const p = localParts(ms, tz)
  const year = p.year !== localParts(now, tz).year ? ` ${p.year}` : ""
  return `${p.weekday} ${p.day} ${p.month}${year} ${p.hour}:${p.minute}`
}

function localParts(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === type)?.value ?? ""
  return { weekday: get("weekday"), day: get("day"), month: get("month"), year: Number(get("year")), hour: get("hour"), minute: get("minute") }
}

function pad(v: string): string {
  return v.padStart(2, "0")
}
