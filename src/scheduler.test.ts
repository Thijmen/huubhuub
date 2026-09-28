import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { firstRun } from "./schedule-spec"
import { MAX_FAILURES, Scheduler, type RunOutcome, type Runner } from "./scheduler"
import { Store, type NewSchedule, type Schedule } from "./store"

const TZ = "Europe/Amsterdam"
const MIN = 60_000

class StubRunner implements Runner {
  started: { id: number; at: number }[] = []
  notes: string[] = []
  /** Outcome per upcoming run; defaults to ok. A pending promise keeps the run going. */
  outcomes: (RunOutcome | Promise<RunOutcome> | Error)[] = []

  async start(s: Schedule, at: number) {
    this.started.push({ id: s.id, at })
    const next = this.outcomes.shift() ?? { status: "ok" as const }
    if (next instanceof Error) throw next
    return { sessionID: `ses_${this.started.length}`, done: Promise.resolve(next) }
  }

  async notify(_chatId: number, html: string) {
    this.notes.push(html)
  }
}

let dir: string
let store: Store
let clock: number
let runner: StubRunner
let scheduler: Scheduler

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-"))
  store = new Store(dir)
  clock = Date.parse("2026-09-28T07:00:00Z")
  runner = new StubRunner()
  scheduler = new Scheduler(store, runner, () => TZ, () => clock)
})

afterEach(() => {
  scheduler.stop()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function add(patch: Partial<NewSchedule> = {}): Schedule {
  const base = { kind: "interval" as const, spec: "every 10m" }
  const when = { kind: patch.kind ?? base.kind, spec: patch.spec ?? base.spec }
  return store.createSchedule(
    {
      chatId: 1,
      name: "job",
      prompt: "do it",
      model: null,
      agent: null,
      silent: false,
      nextAt: firstRun(when, clock, TZ),
      ...when,
      ...patch,
    },
    clock,
  )
}

async function advance(ms: number) {
  clock += ms
  await scheduler.tick()
  await scheduler.idle()
}

describe("Scheduler", () => {
  test("fires due jobs and moves to the next slot", async () => {
    const s = add()
    await advance(5 * MIN)
    expect(runner.started).toHaveLength(0)
    await advance(5 * MIN)
    expect(runner.started).toEqual([{ id: s.id, at: clock }])
    expect(store.schedule(s.id)!.nextAt).toBe(clock + 10 * MIN)
    const [run] = store.runs(s.id)
    expect(run).toMatchObject({ status: "ok", sessionID: "ses_1" })
  })

  test("skips a run while the previous one is still going", async () => {
    const s = add()
    let finish!: (o: RunOutcome) => void
    runner.outcomes.push(new Promise((r) => (finish = r)))
    clock += 10 * MIN
    await scheduler.tick()
    expect(scheduler.running(s.id)).toBe(true)
    clock += 10 * MIN
    await scheduler.tick()
    expect(runner.started).toHaveLength(1)
    expect(store.runs(s.id).map((r) => r.status)).toEqual(["skipped", "running"])
    finish({ status: "ok" })
    await scheduler.idle()
    expect(store.runs(s.id).map((r) => r.status)).toEqual(["skipped", "ok"])
  })

  test("logs recurring runs missed while the bot was down, and fires overdue one-off jobs", () => {
    const recurring = add()
    const once = add({ kind: "once", spec: new Date(clock + 30 * MIN).toISOString(), nextAt: clock + 30 * MIN })
    clock += 2 * 60 * MIN
    scheduler.catchUp()
    expect(store.runs(recurring.id)[0]).toMatchObject({ status: "missed" })
    expect(store.schedule(recurring.id)!.nextAt).toBeGreaterThan(clock)
    expect(runner.started.map((r) => r.id)).toEqual([once.id])
    expect(store.schedule(once.id)!.nextAt).toBeNull()
  })

  test("a run that is far too late counts as missed", async () => {
    const s = add()
    await advance(30 * MIN)
    expect(runner.started).toHaveLength(0)
    expect(store.runs(s.id)[0]!.status).toBe("missed")
    expect(store.schedule(s.id)!.nextAt).toBe(Date.parse("2026-09-28T07:40:00Z"))
  })

  test("marks runs left open by a crash as failed", () => {
    const s = add()
    store.addRun(s.id, "running", clock)
    scheduler.catchUp()
    expect(store.runs(s.id)[0]).toMatchObject({ status: "failed", error: "The bot stopped during this run." })
  })

  test("pauses after three failures in a row and tells the user", async () => {
    const s = add()
    runner.outcomes.push({ status: "failed", error: "boom" }, new Error("no session"), { status: "failed", error: "boom" })
    for (let i = 0; i < MAX_FAILURES; i++) await advance(10 * MIN)
    const after = store.schedule(s.id)!
    expect(after.paused).toBe(true)
    expect(after.failStreak).toBe(3)
    expect(runner.notes).toHaveLength(1)
    expect(runner.notes[0]).toContain("paused")
    expect(store.runs(s.id)[1]).toMatchObject({ status: "failed", error: "no session" })
    await advance(10 * MIN)
    expect(runner.started).toHaveLength(3)
  })

  test("a success resets the failure streak; user stops don't count", async () => {
    const s = add()
    runner.outcomes.push({ status: "failed", error: "x" }, { status: "failed", error: "stopped", counts: false }, { status: "ok" })
    await advance(10 * MIN)
    expect(store.schedule(s.id)!.failStreak).toBe(1)
    await advance(10 * MIN)
    expect(store.schedule(s.id)!.failStreak).toBe(1)
    await advance(10 * MIN)
    expect(store.schedule(s.id)!.failStreak).toBe(0)
  })

  test("silent runs are recorded as silent", async () => {
    const s = add({ silent: true })
    runner.outcomes.push({ status: "silent" })
    await advance(10 * MIN)
    expect(store.runs(s.id)[0]!.status).toBe("silent")
  })

  test("paused jobs don't fire; run now works regardless and keeps the schedule", async () => {
    const s = add()
    store.updateSchedule(s.id, { paused: true })
    await advance(10 * MIN)
    expect(runner.started).toHaveLength(0)
    const nextAt = store.schedule(s.id)!.nextAt
    scheduler.runNow(s.id)
    await scheduler.idle()
    expect(runner.started).toHaveLength(1)
    expect(store.schedule(s.id)!.nextAt).toBe(nextAt)
  })

  test("run now refuses while a run is going", async () => {
    const s = add()
    runner.outcomes.push(new Promise(() => {}))
    scheduler.runNow(s.id)
    expect(() => scheduler.runNow(s.id)).toThrow("already running")
  })

  test("cron jobs follow the configured time zone", async () => {
    const s = add({ kind: "cron", spec: "0 10 * * *", nextAt: firstRun({ kind: "cron", spec: "0 10 * * *" }, clock, TZ) })
    expect(new Date(store.schedule(s.id)!.nextAt!).toISOString()).toBe("2026-09-28T08:00:00.000Z")
    await advance(60 * MIN)
    expect(runner.started).toHaveLength(1)
    expect(new Date(store.schedule(s.id)!.nextAt!).toISOString()).toBe("2026-09-29T08:00:00.000Z")
  })

  test("reschedule recomputes next runs, e.g. after a time zone change", () => {
    let tz = TZ
    const sched = new Scheduler(store, runner, () => tz, () => clock)
    const s = add({ kind: "cron", spec: "0 10 * * *", nextAt: firstRun({ kind: "cron", spec: "0 10 * * *" }, clock, TZ) })
    tz = "UTC"
    sched.reschedule()
    expect(new Date(store.schedule(s.id)!.nextAt!).toISOString()).toBe("2026-09-28T10:00:00.000Z")
  })

  test("deleting a job removes its history", async () => {
    const s = add()
    await advance(10 * MIN)
    store.deleteSchedule(s.id)
    expect(store.runs(s.id)).toHaveLength(0)
  })
})
