import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MEMORY_MAX_PER_USER, MemoryError, Personas } from "./personas"
import { Store } from "./store"

const ME = 111
const PARTNER = 222
const GROUP = -100123
// Saturday 24 October 2026, 15:00 in Amsterdam.
const NOW = Date.UTC(2026, 9, 24, 13, 0)

let dir: string
let store: Store
let personas: Personas

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "personas-"))
  store = new Store(dir)
  personas = new Personas(store, () => "Europe/Amsterdam")
  personas.seed()
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("Personas", () => {
  test("seeds Huub once and makes it the default", () => {
    const [huub] = store.personas()
    expect(huub?.name).toBe("Huub")
    expect(personas.defaultPersonaId).toBe(huub!.id)
    // Deleting it sticks: a restart doesn't bring it back.
    store.deletePersona(huub!.id)
    personas.seed()
    expect(store.personas()).toHaveLength(0)
    expect(personas.defaultPersonaId).toBeNull()
  })

  test("leaves sessions the bot didn't start alone", () => {
    expect(personas.context("ses_webui", NOW)).toEqual({ system: null, memory: false })
  })

  test("a private chat gets the default persona, the date and the memory rules", () => {
    store.set({ chatId: ME, threadId: 7 }, "ses_dm")
    store.seePerson(ME, "Thijmen", "thijmen")
    const { system, memory } = personas.context("ses_dm", NOW)
    expect(memory).toBe(true)
    expect(system).toContain("Je bent Huub")
    expect(system).toContain("You're talking with Thijmen (@thijmen) through Telegram.")
    expect(system).toContain("Today is Saturday, 24 October 2026 (Europe/Amsterdam)")
    expect(system).toContain("Only save a memory when Thijmen explicitly asks you")
    expect(system).toContain("(nothing yet)")
  })

  test("each user gets their own persona and memories", () => {
    const other = store.createPersona("Butler", "You are Jeeves.")
    store.updatePerson(PARTNER, { personaId: other.id })
    store.set({ chatId: ME, threadId: 0 }, "ses_me")
    store.set({ chatId: PARTNER, threadId: 0 }, "ses_partner")
    store.addMemory(ME, "Has a dog called Bram", "agent")
    store.addMemory(PARTNER, "Prefers tea", "agent")

    const mine = personas.context("ses_me", NOW).system!
    const theirs = personas.context("ses_partner", NOW).system!
    expect(mine).toContain("Je bent Huub")
    expect(mine).toContain("Has a dog called Bram")
    expect(mine).not.toContain("Prefers tea")
    expect(theirs).toContain("You are Jeeves.")
    expect(theirs).not.toContain("Je bent Huub")
    expect(theirs).toContain("Prefers tea")
  })

  test("in a group the session belongs to whoever wrote last", () => {
    const key = { chatId: GROUP, threadId: 3 }
    store.set(key, "ses_group")
    expect(personas.userOf("ses_group")).toBeNull()
    expect(personas.context("ses_group", NOW).memory).toBe(false)
    store.touch(key, PARTNER)
    expect(personas.userOf("ses_group")).toBe(PARTNER)
    expect(personas.context("ses_group", NOW).system).toContain("in a group chat")
  })

  test("scheduled runs belong to their chat's user", () => {
    const s = store.createSchedule({ chatId: ME, name: "x", kind: "interval", spec: "every 1h", prompt: "p", model: null, agent: null, silent: false, nextAt: 1 })
    store.setRunSession(store.addRun(s.id, "running", 1), "ses_run")
    expect(personas.userOf("ses_run")).toBe(ME)
    const bg = store.createSchedule({ chatId: null, name: "bg", kind: "interval", spec: "every 1h", prompt: "p", model: null, agent: null, silent: false, nextAt: 1 })
    store.setRunSession(store.addRun(bg.id, "running", 1), "ses_bg")
    const ctx = personas.context("ses_bg", NOW)
    expect(ctx.memory).toBe(false)
    expect(ctx.system).toContain("Je bent Huub")
    expect(ctx.system).not.toContain("# Memory")
  })

  test("memory off removes the memory section and the tools", () => {
    store.set({ chatId: ME, threadId: 0 }, "ses_me")
    store.addMemory(ME, "Has a dog called Bram", "agent")
    store.updatePerson(ME, { memoryMode: "off" })
    const ctx = personas.context("ses_me", NOW)
    expect(ctx.memory).toBe(false)
    expect(ctx.system).not.toContain("Bram")
    expect(ctx.system).toContain("Memory is turned off for user 111")
    expect(() => personas.agentMemory("save", "ses_me", { text: "x" })).toThrow(MemoryError)
  })

  test("automatic memory leaves saving lasting facts to the review step", () => {
    store.set({ chatId: ME, threadId: 0 }, "ses_me")
    personas.setDefaultMemoryMode("auto")
    const system = personas.context("ses_me", NOW).system!
    expect(system).toContain("saved automatically after each reply")
    expect(system).toContain("explicitly asks you to remember, correct or forget")
  })

  test("the agent's memory tools only touch the session user's memories", () => {
    store.set({ chatId: ME, threadId: 0 }, "ses_me")
    const theirs = store.addMemory(PARTNER, "Prefers tea", "agent")
    expect(personas.agentMemory("save", "ses_me", { text: "  Has a   dog " })).toMatch(/^Saved memory #\d+\.$/)
    const [mine] = store.memories(ME)
    expect(mine?.text).toBe("Has a dog")
    // Saving the same thing again doesn't add a copy.
    personas.agentMemory("save", "ses_me", { text: "has a dog" })
    expect(store.memories(ME)).toHaveLength(1)
    personas.agentMemory("update", "ses_me", { id: mine!.id, text: "Has a dog called Bram" })
    expect(store.memory(mine!.id)?.text).toBe("Has a dog called Bram")
    expect(() => personas.agentMemory("forget", "ses_me", { id: theirs.id })).toThrow("no memory")
    personas.agentMemory("forget", "ses_me", { id: mine!.id })
    expect(store.memories(ME)).toHaveLength(0)
    expect(store.memories(PARTNER)).toHaveLength(1)
  })

  test("memories have a size and count limit", () => {
    expect(() => personas.add(ME, "x".repeat(501), "agent")).toThrow("under 500")
    expect(() => personas.add(ME, "   ", "agent")).toThrow("needs some text")
    for (let i = 0; i < MEMORY_MAX_PER_USER; i++) store.addMemory(ME, `fact ${i}`, "agent")
    expect(() => personas.add(ME, "one more", "agent")).toThrow("Memory is full")
  })

  test("a deleted persona falls back to the default", () => {
    const other = store.createPersona("Butler", "You are Jeeves.")
    store.updatePerson(ME, { personaId: other.id })
    store.deletePersona(other.id)
    expect(store.person(ME)?.personaId).toBeNull()
    expect(personas.personaFor(ME)?.name).toBe("Huub")
  })
})

describe("Store threads", () => {
  test("lists a user's threads: where they wrote last, and their private chat", () => {
    store.set({ chatId: ME, threadId: 1 }, "ses_dm")
    store.set({ chatId: GROUP, threadId: 2 }, "ses_group_me")
    store.set({ chatId: GROUP, threadId: 3 }, "ses_group_partner")
    store.touch({ chatId: GROUP, threadId: 2 }, ME)
    store.touch({ chatId: GROUP, threadId: 3 }, PARTNER)
    expect(store.threadsOf(ME).map((t) => t.sessionID).sort()).toEqual(["ses_dm", "ses_group_me"])
    expect(store.threadsOf(PARTNER).map((t) => t.sessionID)).toEqual(["ses_group_partner"])
  })

  test("adds the user column to an existing threads table", () => {
    const old = mkdtempSync(join(tmpdir(), "store-old-"))
    const db = new Database(join(old, "bot.sqlite"), { create: true })
    db.run(`CREATE TABLE threads (chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 0, session_id TEXT NOT NULL,
      auto_title INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (chat_id, thread_id))`)
    db.run("INSERT INTO threads (chat_id, thread_id, session_id, updated_at) VALUES (5, 0, 'ses_old', 1)")
    db.close()
    const s = new Store(old)
    expect(s.bySession("ses_old")?.userId).toBeNull()
    s.touch({ chatId: 5, threadId: 0 }, 5)
    expect(s.bySession("ses_old")?.userId).toBe(5)
    s.close()
    rmSync(old, { recursive: true, force: true })
  })
})
