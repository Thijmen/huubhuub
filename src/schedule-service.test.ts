import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentSchedules } from "./agent-schedules"
import type { Bridge } from "./opencode"
import { AGENT_MAX_SCHEDULES, ScheduleService } from "./schedule-service"
import { Scheduler, type Runner } from "./scheduler"
import { Store } from "./store"

const TZ = "UTC"

const bridge = {
  models: async () => [{ providerID: "anthropic", id: "claude" }],
  agents: async () => [{ id: "build" }],
  selection: async () => ({ model: "anthropic/claude", agent: "build" }),
} as unknown as Bridge

const runner: Runner = { start: async () => ({ sessionID: null, done: Promise.resolve({ status: "ok" }) }), notify: async () => {} }

let dir: string
let store: Store
let scheduler: Scheduler
let service: ScheduleService
let agent: AgentSchedules
const now = Date.parse("2026-10-01T08:00:00Z")

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-svc-"))
  store = new Store(dir)
  scheduler = new Scheduler(store, runner, () => TZ, () => now)
  service = new ScheduleService(store, scheduler, bridge, () => TZ, () => now)
  agent = new AgentSchedules(store, service, scheduler, bridge, () => TZ)
  store.set({ chatId: 1, threadId: 3 }, "ses_chat1")
  store.set({ chatId: 2, threadId: 0 }, "ses_chat2")
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("ScheduleService", () => {
  test("creates prompt and command tasks", async () => {
    const p = await service.create({ chatId: 1, when: "@daily 08:30", prompt: "  Morning  ", command: " gh pr list ", model: "anthropic/claude" })
    expect(p).toMatchObject({ type: "prompt", prompt: "Morning", command: "gh pr list", model: "anthropic/claude", name: "Morning", nextAt: Date.parse("2026-10-01T08:30:00Z") })
    const c = await service.create({ chatId: null, when: "every 1h", type: "command", command: "df -h", prompt: "ignored", model: "anthropic/claude" })
    expect(c).toMatchObject({ chatId: null, type: "command", prompt: "", command: "df -h", model: null, name: "df -h" })
  })

  test("rejects bad input", async () => {
    await expect(service.create({ chatId: 1, when: "@daily 08:30", prompt: " " })).rejects.toThrow("Write the prompt")
    await expect(service.create({ chatId: 1, when: "every 1h", type: "command" })).rejects.toThrow("Write the command")
    await expect(service.create({ chatId: 1, when: "whenever", prompt: "x" })).rejects.toThrow()
    await expect(service.create({ chatId: 1, when: "every 1h", prompt: "x", model: "nope/x" })).rejects.toThrow("isn't available")
  })

  test("updates merge with the stored task", async () => {
    const s = await service.create({ chatId: 1, when: "every 1h", prompt: "x" })
    const u = await service.update(s, { type: "command", command: "ls", chatId: null })
    expect(u).toMatchObject({ type: "command", command: "ls", prompt: "", chatId: null })
    await expect(service.update(u, { command: "" })).rejects.toThrow("Write the command")
    expect((await service.update(u, { paused: true })).paused).toBe(true)
  })
})

describe("AgentSchedules", () => {
  test("creates in the conversation's chat with its model, or in the background", async () => {
    const text = await agent.call("create", "ses_chat1", { when: "every 2h", prompt: "check the build" })
    expect(text).toContain("Results are posted in this chat")
    const [s] = store.schedules()
    expect(s).toMatchObject({ chatId: 1, createdBy: "agent", model: "anthropic/claude", agent: "build" })
    await agent.call("create", "ses_unknown", { when: "in 2h", type: "command", command: "ls" })
    expect(store.schedules(null)).toHaveLength(1)
    await expect(agent.call("create", "ses_unknown", { when: "in 2h", prompt: "x", deliver: "chat" })).rejects.toThrow("background")
  })

  test("only sees its own chat's jobs and the background ones", async () => {
    const mine = await service.create({ chatId: 1, when: "every 1h", prompt: "mine" })
    const theirs = await service.create({ chatId: 2, when: "every 1h", prompt: "theirs" })
    const bg = await service.create({ chatId: null, when: "every 1h", prompt: "bg" })
    const list = await agent.call("list", "ses_chat1", {})
    expect(list).toContain(`#${mine.id}`)
    expect(list).toContain(`#${bg.id}`)
    expect(list).not.toContain(`#${theirs.id}`)
    await expect(agent.call("delete", "ses_chat1", { id: theirs.id })).rejects.toThrow("no schedule")
    expect(await agent.call("delete", "ses_chat1", { id: mine.id })).toContain("Deleted")
    expect(await agent.call("list", "ses_unknown", {})).toContain(`#${theirs.id}`)
  })

  test("can pause, edit and run jobs", async () => {
    const s = await service.create({ chatId: 1, when: "every 1h", prompt: "x" })
    await agent.call("update", "ses_chat1", { id: s.id, paused: true, name: "Renamed" })
    expect(store.schedule(s.id)).toMatchObject({ paused: true, name: "Renamed" })
    expect(await agent.call("run", "ses_chat1", { id: s.id })).toContain("Started")
    await scheduler.idle()
  })

  test("agent-made jobs can't run too often or pile up", async () => {
    await expect(agent.call("create", "ses_chat1", { when: "every 1m", prompt: "spam" })).rejects.toThrow("at most every 5 minutes")
    await expect(agent.call("create", "ses_chat1", { when: "* * * * *", prompt: "spam" })).rejects.toThrow("at most every 5 minutes")
    const s = await service.create({ chatId: 1, when: "every 1m", prompt: "user may" })
    expect(s.spec).toBe("every 1m")
    for (let i = 0; i < AGENT_MAX_SCHEDULES; i++) await agent.call("create", "ses_chat1", { when: "every 1h", prompt: `job ${i}` })
    await expect(agent.call("create", "ses_chat1", { when: "every 1h", prompt: "one more" })).rejects.toThrow("Delete some first")
  })
})
