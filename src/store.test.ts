import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "./store"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "store-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("Store schedules", () => {
  test("upgrades the old schedules table and keeps the run history", () => {
    const db = new Database(join(dir, "bot.sqlite"), { create: true })
    db.run(`CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, spec TEXT NOT NULL,
      prompt TEXT NOT NULL, model TEXT, agent TEXT, silent INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
      fail_streak INTEGER NOT NULL DEFAULT 0, next_at INTEGER, created_at INTEGER NOT NULL)`)
    db.run(`CREATE TABLE schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      session_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, error TEXT)`)
    db.run("INSERT INTO schedules (chat_id, name, kind, spec, prompt, silent, next_at, created_at) VALUES (5, 'old', 'interval', 'every 1h', 'hi', 1, 100, 1)")
    db.run("INSERT INTO schedule_runs (schedule_id, started_at, ended_at, status) VALUES (1, 10, 20, 'ok')")
    db.close()

    const store = new Store(dir)
    const [old] = store.schedules()
    expect(old).toMatchObject({ id: 1, chatId: 5, name: "old", type: "prompt", command: null, silent: true, createdBy: "user", nextAt: 100 })
    expect(store.runs(1)).toEqual([{ id: 1, scheduleId: 1, sessionID: null, startedAt: 10, endedAt: 20, status: "ok", error: null, output: null }])

    const bg = store.createSchedule({ chatId: null, name: "bg", kind: "interval", spec: "every 1h", type: "command", prompt: "", command: "ls", model: null, agent: null, silent: false, nextAt: 5, createdBy: "agent" })
    expect(store.schedules(null).map((s) => s.id)).toEqual([bg.id])
    expect(store.schedules(5).map((s) => s.id)).toEqual([1])
    store.deleteSchedule(1)
    expect(store.runs(1)).toHaveLength(0)
    store.close()

    // Opening again leaves the new table alone.
    const again = new Store(dir)
    expect(again.schedules().map((s) => s.name)).toEqual(["bg"])
    again.close()
  })

  test("keeps the tail of long run output", () => {
    const store = new Store(dir)
    const s = store.createSchedule({ chatId: 1, name: "x", kind: "interval", spec: "every 1h", prompt: "p", model: null, agent: null, silent: false, nextAt: 1 })
    const run = store.addRun(s.id, "running", 1)
    store.finishRun(run, "ok", null, 2, "a".repeat(10_000) + "END")
    expect(store.runs(s.id)[0]!.output).toEndWith("END")
    expect(store.runs(s.id)[0]!.output!.length).toBe(8000)
    store.close()
  })
})

describe("Store spending limits", () => {
  test("adds the columns to an existing people table and stores limits per person", () => {
    const db = new Database(join(dir, "bot.sqlite"), { create: true })
    db.run("CREATE TABLE people (user_id INTEGER PRIMARY KEY, name TEXT, username TEXT, persona_id INTEGER, memory_mode TEXT, seen_at INTEGER)")
    db.run("INSERT INTO people (user_id, name) VALUES (7, 'Sanne')")
    db.close()

    const store = new Store(dir)
    expect(store.person(7)).toMatchObject({ name: "Sanne", spendDaily: null, spendMonthly: null, spendExempt: false })
    store.updatePerson(7, { spendDaily: 2.5, spendExempt: true })
    expect(store.person(7)).toMatchObject({ spendDaily: 2.5, spendMonthly: null, spendExempt: true })
    store.updatePerson(7, { spendDaily: null, spendMonthly: 40, spendExempt: false })
    expect(store.person(7)).toMatchObject({ spendDaily: null, spendMonthly: 40, spendExempt: false })
    store.close()
  })
})
