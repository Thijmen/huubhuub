import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { latestTurns, MemoryReview, parseReview, reviewPrompt } from "./memory-review"
import { Personas } from "./personas"
import { Store } from "./store"

const ME = 111
const user = (id: string, text: string) => ({ type: "user", id, text, time: { created: 1 } })
const reply = (id: string, text: string) => ({ type: "assistant", id, content: [{ type: "text", text }], time: { created: 1 } })
const idle = (id: string) => ({ type: "idle", id, outcome: "succeeded", time: { created: 1 } })

describe("parseReview", () => {
  test("reads plain and fenced JSON, and ignores junk", () => {
    expect(parseReview('{"add": ["Is a fan of FC Twente."], "update": []}')).toEqual({ add: ["Is a fan of FC Twente."], update: [] })
    expect(parseReview('```json\n{"add": [], "update": [{"id": 3, "text": "Has two dogs."}]}\n```')).toEqual({ add: [], update: [{ id: 3, text: "Has two dogs." }] })
    expect(parseReview("Nothing to remember.")).toEqual({ add: [], update: [] })
    expect(parseReview('{"add": [1, "", "ok"], "update": [{"id": "x"}]}')).toEqual({ add: ["ok"], update: [] })
  })
})

describe("latestTurns", () => {
  const newestFirst = [idle("i2"), reply("a2", "Mooi!"), user("u2", "ik ben een fan van fc twente"), idle("i1"), reply("a1", "Hallo!"), user("u1", "hallo")] as never[]

  test("without a watermark, only the latest turn", () => {
    expect(latestTurns(newestFirst)).toEqual([
      { role: "user", text: "ik ben een fan van fc twente" },
      { role: "assistant", text: "Mooi!" },
    ])
  })

  test("with a watermark, everything after it", () => {
    expect(latestTurns(newestFirst, "u1").map((m) => m.text)).toEqual(["Hallo!", "ik ben een fan van fc twente", "Mooi!"])
    expect(latestTurns(newestFirst, "i2")).toEqual([])
  })

  test("the prompt lists what's known and the exchange", () => {
    const prompt = reviewPrompt("Thijmen", [{ id: 4, userId: ME, text: "Has a dog called Bram.", source: "agent", createdAt: 1, updatedAt: 1 }], latestTurns(newestFirst))
    expect(prompt).toContain("#4: Has a dog called Bram.")
    expect(prompt).toContain("Thijmen: ik ben een fan van fc twente")
    expect(prompt).toContain("favourite teams")
  })
})

describe("MemoryReview", () => {
  let dir: string
  let store: Store
  let personas: Personas
  let sent: { chatId: number; text: string; opts: Record<string, unknown> }[]
  let prompts: { sessionID: string; prompt: string }[]
  let created: { title?: string; model?: unknown; permissions?: unknown }[]
  let sessions: Set<string>
  let memoryModel: string | undefined
  let answer: string
  let listener: ((e: unknown) => void) | undefined

  const messages = [idle("i2"), reply("a2", "Mooi!"), user("u2", "ik ben een fan van fc twente"), idle("i1")]
  const review = () =>
    new MemoryReview({
      bridge: {
        subscribeAll: (fn: (e: unknown) => void) => ((listener = fn), () => (listener = undefined)),
        location: { location: { directory: "/ws" } },
        selection: async () => ({ model: "opencode/big-pickle", agent: null }),
        host: {
          message: { list: async () => ({ data: messages, cursor: {} }) },
          session: {
            generate: async (input: { sessionID: string; prompt: string }) => {
              if (!sessions.has(input.sessionID)) throw new Error("Session not found")
              prompts.push(input)
              return { text: answer }
            },
            get: async ({ sessionID }: { sessionID: string }) => {
              if (!sessions.has(sessionID)) throw new Error("Session not found")
              return { id: sessionID }
            },
            create: async (input: { title?: string; model?: unknown; permissions?: unknown }) => {
              created.push(input)
              const id = `ses_review${created.length}`
              sessions.add(id)
              return { id }
            },
          },
        },
      } as never,
      store,
      personas,
      memoryModel: () => memoryModel,
      api: { sendMessage: async (chatId: number, text: string, opts: Record<string, unknown>) => void sent.push({ chatId, text, opts }) } as never,
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "review-"))
    store = new Store(dir)
    personas = new Personas(store, () => "Europe/Amsterdam")
    store.seePerson(ME, "Thijmen", null)
    store.set({ chatId: ME, threadId: 7 }, "ses_dm")
    sent = []
    prompts = []
    created = []
    sessions = new Set(["ses_dm", "ses_run"])
    memoryModel = undefined
    answer = '{"add": ["Is a fan of FC Twente."], "update": []}'
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("saves what the model finds, asking the conversation's model in a review session, and posts it with a Forget button", async () => {
    store.updatePerson(ME, { memoryMode: "auto" })
    await review().review("ses_dm")
    expect(store.memories(ME).map((m) => [m.text, m.source])).toEqual([["Is a fan of FC Twente.", "agent"]])
    expect(created.map((c) => c.model)).toEqual([{ providerID: "opencode", id: "big-pickle" }])
    expect(prompts[0]!.sessionID).toBe("ses_review1")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain("Remembered:</i> Is a fan of FC Twente.")
    expect(sent[0]!.opts.message_thread_id).toBe(7)
    expect(JSON.stringify(sent[0]!.opts.reply_markup)).toContain(`mx:${store.memories(ME)[0]!.id}`)
  })

  test("with a memory model, reviews run in one empty session for that model, kept across restarts", async () => {
    store.updatePerson(ME, { memoryMode: "auto" })
    memoryModel = "opencode/glm-5.3-flash-free"
    const r = review()
    await r.review("ses_dm")
    expect(created).toEqual([
      {
        location: { directory: "/ws" },
        title: "Memory review (opencode/glm-5.3-flash-free)",
        metadata: { purpose: "memory-review" },
        model: { providerID: "opencode", id: "glm-5.3-flash-free" },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      } as never,
    ])
    expect(prompts.map((p) => p.sessionID)).toEqual(["ses_review1"])
    expect(store.memories(ME)).toHaveLength(1)

    // A restarted bot finds the same session.
    store.clearMemories(ME)
    await review().review("ses_dm")
    expect(created).toHaveLength(1)
    expect(prompts.map((p) => p.sessionID)).toEqual(["ses_review1", "ses_review1"])
  })

  test("makes a new review session when the old one was deleted", async () => {
    store.updatePerson(ME, { memoryMode: "auto" })
    memoryModel = "opencode/glm-5.3-flash-free"
    const r = review()
    await r.review("ses_dm")
    sessions.delete("ses_review1")
    store.clearMemories(ME)
    messages.unshift(idle("i3"), reply("a3", "Top!"), user("u3", "ik heb een hond"))
    try {
      await r.review("ses_dm")
    } finally {
      messages.splice(0, 3)
    }
    expect(created).toHaveLength(2)
    expect(prompts.at(-1)!.sessionID).toBe("ses_review2")
  })

  test("reviews each turn once", async () => {
    store.updatePerson(ME, { memoryMode: "auto" })
    const r = review()
    await r.review("ses_dm")
    await r.review("ses_dm")
    expect(prompts).toHaveLength(1)
  })

  test("doesn't post anything when nothing is new", async () => {
    store.updatePerson(ME, { memoryMode: "auto" })
    store.addMemory(ME, "Is a fan of FC Twente.", "agent")
    await review().review("ses_dm")
    expect(store.memories(ME)).toHaveLength(1)
    expect(sent).toHaveLength(0)
  })

  test("updates a memory the model says changed, but only the user's own", async () => {
    store.updatePerson(ME, { memoryMode: "auto" })
    const mine = store.addMemory(ME, "Likes football.", "agent")
    const theirs = store.addMemory(222, "Likes tea.", "agent")
    answer = JSON.stringify({ add: [], update: [{ id: mine.id, text: "Is a fan of FC Twente." }, { id: theirs.id, text: "hacked" }] })
    await review().review("ses_dm")
    expect(store.memory(mine.id)?.text).toBe("Is a fan of FC Twente.")
    expect(store.memory(theirs.id)?.text).toBe("Likes tea.")
    expect(sent[0]!.text).toContain("Updated:")
  })

  test("only runs for automatic memory in Telegram conversations", async () => {
    await review().review("ses_dm") // default mode is "explicit"
    const s = store.createSchedule({ chatId: ME, name: "x", kind: "interval", spec: "every 1h", prompt: "p", model: null, agent: null, silent: false, nextAt: 1 })
    store.setRunSession(store.addRun(s.id, "running", 1), "ses_run")
    store.set({ chatId: ME, threadId: 9 }, "ses_run")
    store.updatePerson(ME, { memoryMode: "auto" })
    await review().review("ses_run")
    expect(prompts).toHaveLength(0)
  })

  test("a finished turn triggers a review", async () => {
    store.updatePerson(ME, { memoryMode: "auto" })
    const r = review()
    r.start()
    listener!({ type: "session.execution.succeeded", data: { sessionID: "ses_dm" } })
    listener!({ type: "session.execution.succeeded", data: { sessionID: "ses_other" } })
    await Bun.sleep(1700)
    r.stop()
    expect(prompts).toHaveLength(1)
    expect(store.memories(ME)).toHaveLength(1)
  })
})
