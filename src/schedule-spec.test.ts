import { describe, expect, test } from "bun:test"
import { defaultName, describe as describeWhen, firstRun, nextRun, parseInput, parseWhen, SpecError, upcoming, zonedTime } from "./schedule-spec"

const AMS = "Europe/Amsterdam"
const at = (iso: string) => Date.parse(iso)
/** Wall-clock time in Amsterdam as "YYYY-MM-DD HH:MM". */
const local = (ms: number, tz = AMS) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms)

const NOW = at("2026-09-28T07:14:00Z") // Mon 09:14 in Amsterdam

describe("parseInput", () => {
  test("detects cron expressions", () => {
    const p = parseInput("0 8 * * 1-5 Summarise my inbox", NOW, AMS)
    expect(p).toMatchObject({ kind: "cron", spec: "0 8 * * 1-5", prompt: "Summarise my inbox" })
    expect(local(p.nextAt)).toBe("2026-09-29 08:00")
  })

  test("detects shortcuts", () => {
    expect(parseInput("@hourly ping", NOW, AMS)).toMatchObject({ kind: "cron", spec: "@hourly", prompt: "ping" })
    const daily = parseInput("@daily 08:30 news", NOW, AMS)
    expect(daily).toMatchObject({ kind: "cron", spec: "30 8 * * *", prompt: "news" })
    expect(local(daily.nextAt)).toBe("2026-09-29 08:30")
    expect(local(parseInput("@daily midnight job", NOW, AMS).nextAt)).toBe("2026-09-29 00:00")
    expect(parseInput("every 30m check", NOW, AMS)).toMatchObject({ kind: "interval", spec: "every 30m", nextAt: NOW + 30 * 60_000 })
    expect(parseInput("every 2 hours check", NOW, AMS).spec).toBe("every 2h")
  })

  test("one-off jobs", () => {
    const inTwo = parseInput("in 2h remind me", NOW, AMS)
    expect(inTwo).toMatchObject({ kind: "once", prompt: "remind me", nextAt: NOW + 2 * 3_600_000 })
    const on = parseInput("at 2026-10-01 09:00 deploy", NOW, AMS)
    expect(on.kind).toBe("once")
    expect(new Date(on.nextAt).toISOString()).toBe("2026-10-01T07:00:00.000Z")
    expect(local(parseInput("at 08:00 later", NOW, AMS).nextAt)).toBe("2026-09-29 08:00")
    expect(local(parseInput("at 18:00 today", NOW, AMS).nextAt)).toBe("2026-09-28 18:00")
  })

  test("keeps the prompt's line breaks", () => {
    expect(parseInput("@daily   first line\nsecond line", NOW, AMS).prompt).toBe("first line\nsecond line")
  })

  test("rejects bad input", () => {
    expect(() => parseInput("", NOW, AMS)).toThrow(SpecError)
    expect(() => parseInput("@daily", NOW, AMS)).toThrow("Add the prompt")
    expect(() => parseInput("hello there how are you today", NOW, AMS)).toThrow(SpecError)
    expect(() => parseInput("61 * * * * nope", NOW, AMS)).toThrow("out of range")
    expect(() => parseInput("at 2020-01-01 09:00 past", NOW, AMS)).toThrow("in the past")
    expect(() => parseInput("every 0m spin", NOW, AMS)).toThrow(SpecError)
    expect(() => parseInput("@daily 25:00 x", NOW, AMS)).toThrow("hour")
    expect(() => parseInput("0 0 30 2 * never", NOW, AMS)).toThrow("never runs")
  })
})

describe("time zones", () => {
  test("the same cron runs at different instants per zone", () => {
    const ams = firstRun({ kind: "cron", spec: "0 9 * * *" }, NOW, AMS)
    const ny = firstRun({ kind: "cron", spec: "0 9 * * *" }, NOW, "America/New_York")
    expect(new Date(ams).toISOString()).toBe("2026-09-29T07:00:00.000Z")
    expect(new Date(ny).toISOString()).toBe("2026-09-28T13:00:00.000Z")
  })

  test("daily jobs keep their wall-clock time across the October DST change", () => {
    const runs = upcoming({ kind: "cron", spec: "0 8 * * *" }, at("2026-10-24T12:00:00Z"), AMS, 2)
    expect(runs.map((r) => local(r))).toEqual(["2026-10-25 08:00", "2026-10-26 08:00"])
    expect(new Date(runs[0]!).toISOString()).toBe("2026-10-25T07:00:00.000Z")
    expect(runs[1]! - runs[0]!).toBe(24 * 3_600_000)
  })

  test("daily jobs keep their wall-clock time across the March DST change", () => {
    const runs = upcoming({ kind: "cron", spec: "0 8 * * *" }, at("2026-03-28T12:00:00Z"), AMS, 2)
    expect(runs.map((r) => local(r))).toEqual(["2026-03-29 08:00", "2026-03-30 08:00"])
    expect(runs[0]! - at("2026-03-28T07:00:00Z")).toBe(23 * 3_600_000)
  })

  test("a time in the skipped hour moves forward", () => {
    const next = firstRun({ kind: "cron", spec: "30 2 * * *" }, at("2026-03-28T12:00:00Z"), AMS)
    expect(local(next)).toBe("2026-03-29 03:30")
  })

  test("zonedTime converts wall-clock times", () => {
    expect(new Date(zonedTime(2026, 1, 15, 9, 0, AMS)).toISOString()).toBe("2026-01-15T08:00:00.000Z")
    expect(new Date(zonedTime(2026, 7, 15, 9, 0, AMS)).toISOString()).toBe("2026-07-15T07:00:00.000Z")
    expect(() => zonedTime(2026, 2, 30, 9, 0, AMS)).toThrow(SpecError)
  })
})

describe("nextRun", () => {
  test("intervals stay on their grid and skip missed slots", () => {
    const when = { kind: "interval" as const, spec: "every 1h" }
    const base = at("2026-09-28T08:00:00Z")
    expect(nextRun(when, base, base, AMS)).toBe(base + 3_600_000)
    expect(nextRun(when, base, base + 3.5 * 3_600_000, AMS)).toBe(base + 4 * 3_600_000)
    expect(nextRun(when, base + 3_600_000, base, AMS)).toBe(base + 3_600_000)
  })

  test("one-off jobs have no next run", () => {
    expect(nextRun({ kind: "once", spec: "2026-10-01T07:00:00.000Z" }, 1, NOW, AMS)).toBeNull()
  })
})

describe("describe and names", () => {
  test("describes schedules", () => {
    expect(describeWhen(parseWhen("@daily 08:05", NOW, AMS), AMS)).toBe("every day at 08:05")
    expect(describeWhen({ kind: "interval", spec: "every 1h" }, AMS)).toBe("every hour")
    expect(describeWhen({ kind: "interval", spec: "every 15m" }, AMS)).toBe("every 15 minutes")
    expect(describeWhen({ kind: "cron", spec: "@hourly" }, AMS)).toBe("every hour")
    expect(describeWhen({ kind: "cron", spec: "0 8 * * 1-5" }, AMS)).toBe("cron 0 8 * * 1-5")
    expect(describeWhen({ kind: "once", spec: "2026-10-01T07:00:00.000Z" }, AMS)).toStartWith("once, Thu 1 Oct")
  })

  test("default names clip the prompt", () => {
    expect(defaultName("  short\nprompt ")).toBe("short prompt")
    const long = defaultName("Summarise every open GitHub issue in the repository and rank them")
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long).toEndWith("…")
  })
})
