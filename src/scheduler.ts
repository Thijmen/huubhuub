import { formatTime, nextRun, SpecError } from "./schedule-spec"
import type { Schedule, Store } from "./store"

/** How late a recurring run may start before it counts as missed (e.g. the host was asleep). */
const GRACE_MS = 5 * 60_000
const MAX_SLEEP_MS = 60_000
export const MAX_FAILURES = 3

export type RunOutcome = { status: "ok" | "silent" | "failed"; error?: string; counts?: boolean; output?: string }

export interface Runner {
  /** Start a run and resolve once it's under way; `done` settles when the run ends. Command tasks have no session. */
  start(schedule: Schedule, startedAt: number): Promise<{ sessionID: string | null; done: Promise<RunOutcome> }>
  /** Tell the job's chat, or every allowlisted user for a background job. */
  notify(chatId: number | null, html: string): Promise<void>
}

type Listener = () => void

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = new Map<number, Promise<void>>()
  private listeners = new Set<Listener>()
  private stopped = false

  constructor(
    private readonly store: Store,
    private readonly runner: Runner,
    private readonly timeZone: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Recover after a restart, then keep firing jobs. */
  start(): void {
    this.catchUp()
    this.arm()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  running(id: number): boolean {
    return this.active.has(id)
  }

  /** Wait for the runs in flight; used by tests. */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all(this.active.values())
  }

  /**
   * Runs left open by the previous process failed; recurring runs that came due while the bot was
   * down are logged as missed and skipped; one-off jobs that were due fire now.
   */
  catchUp(): void {
    const now = this.now()
    this.store.abandonRuns(now)
    for (const s of this.store.schedules()) {
      if (s.paused || s.nextAt === null || s.nextAt > now) continue
      if (s.kind === "once") {
        void this.fire(s, false)
        continue
      }
      this.miss(s, now)
    }
    this.changed()
  }

  /** Fire every job that is due. */
  async tick(): Promise<void> {
    const now = this.now()
    for (const s of this.store.schedules()) {
      if (s.paused || s.nextAt === null || s.nextAt > now) continue
      if (s.kind !== "once" && now - s.nextAt > GRACE_MS) {
        this.miss(s, now)
        continue
      }
      if (this.active.has(s.id)) {
        this.store.addRun(s.id, "skipped", now, "The previous run was still going.")
        this.advance(s, now)
        continue
      }
      void this.fire(s, false)
    }
    this.changed()
  }

  /** Run a job now, outside its schedule. */
  runNow(id: number): void {
    const s = this.store.schedule(id)
    if (!s) throw new SpecError("That schedule no longer exists.")
    if (this.active.has(id)) throw new SpecError("This job is already running.")
    void this.fire(s, true)
    this.changed()
  }

  /** Recompute next run times, e.g. after the time zone changed or a job was edited or resumed. */
  reschedule(id?: number): void {
    const now = this.now()
    for (const s of id === undefined ? this.store.schedules() : [this.store.schedule(id)].filter((x) => x !== undefined)) {
      if (s.kind === "once") continue
      this.store.updateSchedule(s.id, { nextAt: nextRun(s, null, now, this.timeZone()) })
    }
    this.changed()
  }

  /** Call after creating, editing or deleting a job so the timer and listeners pick it up. */
  refresh(): void {
    this.changed()
  }

  private miss(s: Schedule, now: number): void {
    const next = nextRun(s, s.nextAt, now, this.timeZone())
    this.store.addRun(s.id, "missed", s.nextAt!, `Missed the run at ${formatTime(s.nextAt!, this.timeZone(), now)}: the bot wasn't running.`)
    this.store.updateSchedule(s.id, { nextAt: next })
  }

  private advance(s: Schedule, now: number): void {
    this.store.updateSchedule(s.id, { nextAt: nextRun(s, s.nextAt, now, this.timeZone()) })
  }

  private fire(s: Schedule, manual: boolean): Promise<void> {
    const startedAt = this.now()
    if (!manual) this.advance(s, startedAt)
    const runId = this.store.addRun(s.id, "running", startedAt)
    const job = this.execute(s, runId, startedAt).finally(() => {
      this.active.delete(s.id)
      this.changed()
    })
    this.active.set(s.id, job)
    return job
  }

  private async execute(s: Schedule, runId: number, startedAt: number): Promise<void> {
    let outcome: RunOutcome
    try {
      const run = await this.runner.start(s, startedAt)
      if (run.sessionID) {
        this.store.setRunSession(runId, run.sessionID)
        this.changed()
      }
      outcome = await run.done
    } catch (err) {
      outcome = { status: "failed", error: err instanceof Error ? err.message : String(err) }
    }
    this.store.finishRun(runId, outcome.status, outcome.error ?? null, this.now(), outcome.output ?? null)
    const current = this.store.schedule(s.id)
    if (!current) return
    if (outcome.status !== "failed") {
      if (current.failStreak) this.store.updateSchedule(s.id, { failStreak: 0 })
      return
    }
    if (outcome.counts === false) return
    const streak = current.failStreak + 1
    const pause = streak >= MAX_FAILURES && !current.paused
    this.store.updateSchedule(s.id, { failStreak: streak, ...(pause ? { paused: true } : {}) })
    if (pause) {
      const how = s.chatId === null ? "Resume it on the Schedules page of the admin UI." : "Resume it with /schedules."
      await this.runner
        .notify(s.chatId, `⏸ <b>${escape(s.name)}</b> failed ${streak} times in a row, so I paused it. ${how}`)
        .catch((err) => console.error("schedule notify failed", err))
    }
  }

  private arm(): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    const now = this.now()
    const next = Math.min(...this.store.schedules().flatMap((s) => (s.paused || s.nextAt === null ? [] : [s.nextAt])))
    const wait = Math.max(0, Math.min(MAX_SLEEP_MS, next - now))
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err) => console.error("scheduler tick failed", err))
        .finally(() => this.arm())
    }, wait)
  }

  private changed(): void {
    if (this.timer && !this.stopped) this.arm()
    for (const fn of this.listeners) fn()
  }
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
