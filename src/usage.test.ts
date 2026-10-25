import { describe, expect, test } from "bun:test"
import { costsText } from "./cost-commands"
import type { ChatState, Schedule, ScheduleRun } from "./store"
import { bucketMessages, Usage } from "./usage"

const HOUR = 3_600_000

const msg = (created: number, cost: number, id = "claude") =>
  ({
    type: "assistant",
    id: String(created),
    time: { created },
    agent: "build",
    model: { providerID: "anthropic", id },
    content: [],
    cost,
    tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 2 } },
  }) as never

test("bucketMessages sums assistant turns per hour and model", () => {
  const out = bucketMessages([msg(HOUR + 1, 0.1), msg(HOUR + 5000, 0.2), msg(2 * HOUR, 0.3), msg(HOUR, 1, "other"), { type: "user" } as never])
  const first = out.find((b) => b.hour === HOUR && b.model === "anthropic/claude")!
  expect(first.cost).toBeCloseTo(0.3)
  expect(first.turns).toBe(2)
  expect(first.cacheRead).toBe(200)
  expect(out).toHaveLength(3)
})

describe("Usage", () => {
  type S = { id: string; parentID?: string; metadata?: Record<string, unknown>; time: { created: number; updated: number }; cost: number; title?: string }
  function setup() {
    const sessions: S[] = [
      { id: "chat", time: { created: 0, updated: 1 }, cost: 0 },
      { id: "sub", parentID: "chat", time: { created: 0, updated: 1 }, cost: 0 },
      { id: "job", time: { created: 0, updated: 1 }, cost: 0 },
      { id: "mem", metadata: { purpose: "memory-review" }, time: { created: 0, updated: 1 }, cost: 0 },
    ]
    const messages: Record<string, unknown[]> = {
      chat: [msg(10 * HOUR, 1)],
      sub: [msg(10 * HOUR + 10, 0.5, "haiku")],
      job: [msg(11 * HOUR, 2)],
      mem: [msg(11 * HOUR, 4)],
    }
    const bridge = {
      host: {
        session: {
          list: async () => ({ data: sessions, cursor: {} }),
          get: async ({ sessionID }: { sessionID: string }) => sessions.find((s) => s.id === sessionID) ?? Promise.reject(new Error("gone")),
        },
        message: { list: async ({ sessionID }: { sessionID: string }) => ({ data: messages[sessionID] ?? [], cursor: {} }) },
      },
    }
    const store = {
      bySession: (id: string) => (id === "chat" ? ({ chatId: -100, threadId: 3, sessionID: "chat", userId: 7 } as ChatState) : undefined),
      runBySession: (id: string) => (id === "job" ? ({ scheduleId: 1 } as ScheduleRun) : undefined),
      schedule: () => ({ name: "Digest", chatId: 9 }) as Schedule,
      people: () => [],
      ownerOfChat: (chatId: number) => (chatId > 0 ? chatId : null),
    }
    return { usage: new Usage(bridge as never, store), sessions, messages }
  }

  test("attributes subagents to their conversation and scheduled runs to the private chat", async () => {
    const { usage } = setup()
    await usage.sync()
    expect(usage.owner("sub")).toMatchObject({ root: "chat", source: "conversation", userId: 7 })
    expect(usage.owner("job")).toMatchObject({ source: "schedule", userId: 9, schedule: "Digest" })
    expect(usage.owner("mem")).toMatchObject({ source: "memory", userId: null })
    expect(usage.spentBy(7, 0)).toBeCloseTo(1.5)
    expect(usage.spentBy(7, 11 * HOUR)).toBe(0)
    expect(usage.spentBy(9, 0)).toBeCloseTo(2)
  })

  test("counts live model calls until the next scan includes them", async () => {
    const { usage, sessions, messages } = setup()
    await usage.sync()
    await usage.observe("sub", Date.now(), 0.25)
    expect(usage.spentBy(7, 0)).toBeCloseTo(1.75)
    expect(usage.totals("chat")).toMatchObject({ turns: 3, subagents: 1 })
    expect(usage.totals("chat").cost).toBeCloseTo(1.75)

    messages.sub!.push(msg(12 * HOUR, 0.25, "haiku"))
    sessions[1]!.time.updated = 2
    await usage.sync(0)
    expect(usage.spentBy(7, 0)).toBeCloseTo(1.75)
    expect(usage.totals("chat").models).toEqual([
      { model: "anthropic/claude", cost: 1 },
      { model: "anthropic/haiku", cost: 0.75 },
    ])
  })

  test("learns about sessions created since the last scan", async () => {
    const { usage, sessions } = setup()
    await usage.sync()
    sessions.push({ id: "sub2", parentID: "chat", time: { created: 0, updated: 1 }, cost: 0 })
    await usage.observe("sub2", Date.now(), 3)
    expect(usage.owner("sub2")?.userId).toBe(7)
    expect(usage.spentBy(7, 0)).toBeCloseTo(4.5)
  })
})

test("costsText shows the conversation and the person's limits", () => {
  const text = costsText(
    { cost: 1.5, turns: 3, tokens: { input: 1200, output: 300, reasoning: 0, cacheRead: 5000, cacheWrite: 0 }, models: [{ model: "anthropic/claude", cost: 1 }, { model: "anthropic/haiku", cost: 0.5 }], subagents: 1 },
    {
      userId: 7,
      exempt: false,
      day: { period: "day", spent: 4.2, limit: 5, from: 0, resetsAt: Date.UTC(2026, 9, 24, 22) },
      month: { period: "month", spent: 12, limit: null, from: 0, resetsAt: 0 },
    },
    "Europe/Amsterdam",
    Date.UTC(2026, 9, 24, 12),
  )
  expect(text).toContain("<b>$1.50</b> · 3 model calls · 1.5k tokens (+5.0k from cache)")
  expect(text).toContain("• haiku: $0.500")
  expect(text).toContain("Includes 1 subagent session.")
  expect(text).toContain("Today: $4.20 of $5.00 (84%) ⚠️ · resets Sun 25 Oct 00:00")
  expect(text).toContain("This month: $12.00")
})
