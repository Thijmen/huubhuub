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

describe("Store merging people", () => {
  const schedule = (store: Store, chatId: number) =>
    store.createSchedule({ chatId, name: "s", kind: "interval", spec: "every 1h", prompt: "p", model: null, agent: null, silent: false, nextAt: 1 })

  test("an app-only person joins their Telegram self, with everything they had", () => {
    const store = new Store(dir)
    const telegram = store.seePerson(42, "Thijmen", "thijmen", 100)
    const app = store.createAppPerson("Thijmen (app)")
    store.updatePerson(app.id, { memoryMode: "auto", spendDaily: 3 })
    store.updatePerson(telegram, { spendDaily: 5 })
    store.addMemory(app.id, "Has a dog called Bram", "agent")
    store.addMemory(app.id, "Likes tea", "user")
    store.addMemory(telegram, "Likes tea", "user")
    const device = store.addDevice({ id: "d1", personId: app.id, tokenHash: "h", name: "Pixel", platform: "android" })
    store.set({ chatId: app.appChatId!, threadId: 1 }, "ses_app")
    store.touch({ chatId: app.appChatId!, threadId: 1 }, app.id)
    store.set({ chatId: 42, threadId: 7 }, "ses_tg")

    const merged = store.mergePeople(app.id, telegram)

    expect(merged).toMatchObject({ id: 42, telegramId: 42, appChatId: app.appChatId, name: "Thijmen", username: "thijmen", memoryMode: "auto", spendDaily: 5, seenAt: 100 })
    expect(store.person(app.id)).toBeUndefined()
    expect(store.memories(42).map((m) => m.text).sort()).toEqual(["Has a dog called Bram", "Likes tea"])
    expect(store.device(device.id)?.personId).toBe(42)
    expect(store.ownerOfChat(app.appChatId!)).toBe(42)
    expect(store.bySession("ses_app")?.userId).toBe(42)
    expect(store.conversationsOf(42).map((c) => c.sessionID).sort()).toEqual(["ses_app", "ses_tg"])
    expect(store.seePerson(42, "Thijmen", "thijmen")).toBe(42)
    store.close()
  })

  test("the order doesn't matter: Telegram survives", () => {
    const store = new Store(dir)
    const app = store.createAppPerson("Sanne")
    const telegram = store.seePerson(7, null, null)
    expect(store.mergePeople(telegram, app.id)).toMatchObject({ id: 7, telegramId: 7, appChatId: app.appChatId, name: "Sanne" })
    store.close()
  })

  test("when both have app conversations, they end up in one app chat", () => {
    const store = new Store(dir)
    const telegram = store.seePerson(42, "Thijmen", null)
    const mine = store.appChatOf(telegram)
    store.set({ chatId: mine, threadId: 1 }, "ses_a")
    store.set({ chatId: mine, threadId: 2 }, "ses_b")
    const app = store.createAppPerson("Thijmen")
    store.set({ chatId: app.appChatId!, threadId: 1 }, "ses_c")
    store.set({ chatId: app.appChatId!, threadId: 2 }, "ses_d")
    const theirs = schedule(store, app.appChatId!)

    const merged = store.mergePeople(telegram, app.id)

    expect(merged.appChatId).toBe(mine)
    expect(store.bySession("ses_a")).toMatchObject({ chatId: mine, threadId: 1 })
    expect(store.bySession("ses_c")).toMatchObject({ chatId: mine, threadId: 3 })
    expect(store.bySession("ses_d")).toMatchObject({ chatId: mine, threadId: 4 })
    expect(store.schedule(theirs.id)?.chatId).toBe(mine)
    expect(store.conversationsOf(42).length).toBe(4)
    expect(store.ownerOfChat(app.appChatId!)).toBeNull()
    store.close()
  })

  test("two app-only people: the older one survives", () => {
    const store = new Store(dir)
    const first = store.createAppPerson("Sanne")
    const second = store.createAppPerson(null)
    store.updatePerson(second.id, { spendExempt: true })
    expect(store.mergePeople(second.id, first.id)).toMatchObject({ id: first.id, name: "Sanne", spendExempt: true })
    expect(store.person(second.id)).toBeUndefined()
    store.close()
  })

  test("refuses two Telegram accounts, the same person, or someone unknown", () => {
    const store = new Store(dir)
    const a = store.seePerson(1, "A", null)
    const b = store.seePerson(2, "B", null)
    expect(() => store.mergePeople(a, b)).toThrow("only have one Telegram account")
    expect(() => store.mergePeople(a, a)).toThrow("same person")
    expect(() => store.mergePeople(a, 999)).toThrow("no person 999")
    expect(store.person(a)).toBeDefined()
    expect(store.person(b)).toBeDefined()
    store.close()
  })

  test("link codes work once and expire", () => {
    const store = new Store(dir)
    const app = store.createAppPerson("Sanne")
    store.addTelegramLink("h1", app.id, 1000, 0)
    expect(store.takeTelegramLink("h1", 500)).toBe(app.id)
    expect(store.takeTelegramLink("h1", 600)).toBeUndefined()
    store.addTelegramLink("h2", app.id, 1000, 0)
    expect(store.takeTelegramLink("h2", 1000)).toBeUndefined()
    store.close()
  })
})
