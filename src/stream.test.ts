import { afterEach, describe, expect, test } from "bun:test"
import type { Api } from "grammy"
import type { Bridge, SessionEvent, TranscriptBlock } from "./opencode"
import { Questions } from "./question"
import { ChatView } from "./stream"

type Call = { method: string; text?: string; draftID?: number; at: number }

function fakeApi(opts: { draftsFail?: boolean } = {}) {
  const calls: Call[] = []
  let nextID = 100
  const api = {
    sendMessage: async (_chat: number, text: string) => (calls.push({ method: "sendMessage", text, at: Date.now() }), { message_id: nextID++ }),
    editMessageText: async (_chat: number, _id: number, text: string) => (calls.push({ method: "editMessageText", text, at: Date.now() }), true),
    sendMessageDraft: async (_chat: number, draftID: number, text: string) => {
      if (opts.draftsFail) throw new Error("Bad Request: method not available")
      calls.push({ method: "sendMessageDraft", text, draftID, at: Date.now() })
      return true
    },
    sendChatAction: async () => true,
  }
  return { api: api as unknown as Api, calls }
}

function fakeBridge(stored: TranscriptBlock[] = []) {
  let listener: ((e: SessionEvent) => void) | undefined
  let resync: (() => void) | undefined
  const state = { stored, active: true, interrupted: 0 }
  const bridge = {
    subscribe: (_: string, fn: (e: SessionEvent) => void) => ((listener = fn), () => {}),
    onResync: (fn: () => void) => ((resync = fn), () => {}),
    transcript: async () => state.stored,
    isActive: async () => state.active,
    interrupt: async () => void state.interrupted++,
  }
  const emit = (type: string, data: Record<string, unknown> = {}) => listener!({ type, data: { sessionID: "s", ...data } } as unknown as SessionEvent)
  return { bridge: bridge as unknown as Bridge, emit, state, resync: () => resync!() }
}

const views: ChatView[] = []
const questions: Questions[] = []
function setup(opts: { chatId?: number; mode?: "draft" | "edit"; stored?: TranscriptBlock[]; draftsFail?: boolean } = {}) {
  const { api, calls } = fakeApi(opts)
  const b = fakeBridge(opts.stored)
  const q = new Questions({ reply: async () => {} }, () => 10)
  const view = new ChatView(api, b.bridge, { chatId: opts.chatId ?? 1, threadId: 0 }, "s", q, () => opts.mode ?? "draft")
  views.push(view)
  questions.push(q)
  return { ...b, calls, view }
}

afterEach(() => {
  for (const v of views.splice(0)) v.dispose()
  for (const q of questions.splice(0)) q.dispose()
})

const settle = (ms = 20) => Bun.sleep(ms)
/** Long enough for a final message held back behind a fresh draft. */
const FINAL_MS = 1100
const sent = (calls: Call[]) => calls.filter((c) => c.method === "sendMessage").map((c) => c.text)

describe("ChatView", () => {
  test("finishes from the stored transcript when text events were lost", async () => {
    const { emit, calls } = setup({
      mode: "edit",
      stored: [
        { kind: "tool", id: "t1", name: "webfetch", input: { url: "https://x.nl" }, status: "ok" },
        { kind: "text", text: "Het **nieuws**" },
      ],
    })
    emit("session.execution.started")
    emit("session.tool.input.started", { id: "t1", name: "webfetch" })
    emit("session.execution.succeeded")
    await settle()
    expect(calls.at(-1)!.text).toBe("Het <b>nieuws</b>")
  })

  test("shows what a running tool is doing, then only the answer", async () => {
    const { emit, calls } = setup()
    emit("session.execution.started")
    emit("session.tool.input.started", { id: "t1", name: "webfetch" })
    emit("session.tool.called", { id: "t1", input: { url: "https://www.1twente.nl" } })
    await settle(600)
    expect(calls.at(-1)).toMatchObject({ method: "sendMessageDraft", text: "🌐 Reading 1twente.nl… 0s" })
    emit("session.tool.success", { id: "t1" })
    emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "Nieuws" })
    await settle(600)
    expect(calls.at(-1)!.text).toMatch(/^Nieuws\n\n✻ .+… \ds$/)
    emit("session.execution.succeeded")
    await settle(FINAL_MS)
    expect(sent(calls)).toEqual(["Nieuws"])
  })

  test("keeps the live text when storage has less", async () => {
    const { emit, calls } = setup({ mode: "edit", stored: [{ kind: "text", text: "a" }] })
    emit("session.execution.started")
    emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "the full answer" })
    emit("session.execution.succeeded")
    await settle()
    expect(calls.at(-1)!.text).toBe("the full answer")
  })

  test("finalizes a run whose end event never arrived after the stream reconnects", async () => {
    const { emit, calls, state, resync } = setup({ mode: "edit", stored: [{ kind: "text", text: "done" }] })
    emit("session.execution.started")
    resync()
    await settle()
    expect(calls.length).toBe(0)
    state.active = false
    resync()
    await settle()
    expect(sent(calls)).toEqual(["done"])
  })

  test("streams drafts with one draft ID, then sends the final message", async () => {
    const { emit, calls } = setup({ stored: [] })
    emit("session.execution.started")
    emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "Hel" })
    await settle(600)
    emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "lo" })
    await settle(600)
    emit("session.execution.succeeded")
    await settle(FINAL_MS)
    const drafts = calls.filter((c) => c.method === "sendMessageDraft")
    expect(drafts.some((d) => d.text!.startsWith("Hel\n\n✻ "))).toBe(true)
    expect(drafts.at(-1)!.text).toStartWith("Hello\n\n✻ ")
    expect(new Set(drafts.map((d) => d.draftID)).size).toBe(1)
    expect(calls.some((c) => c.method === "editMessageText")).toBe(false)
    expect(sent(calls)).toEqual(["Hello"])
  })

  test("groups edit in place instead of drafting", async () => {
    const { emit, calls } = setup({ chatId: -100 })
    emit("session.execution.started")
    emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "Hi" })
    await settle(1300)
    emit("session.execution.succeeded")
    await settle()
    expect(calls[0]).toMatchObject({ method: "sendMessage" })
    expect(calls[0]!.text).toStartWith("Hi\n\n✻ ")
    expect(calls.slice(1).every((c) => c.method === "editMessageText")).toBe(true)
    expect(calls.at(-1)!.text).toBe("Hi")
  })

  test("falls back to editing when drafts are unavailable", async () => {
    const { emit, calls } = setup({ draftsFail: true })
    emit("session.execution.started")
    emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "Hi" })
    await settle(600)
    emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "!" })
    await settle(1300)
    emit("session.execution.succeeded")
    await settle()
    expect(calls[0]!.method).toBe("sendMessage")
    expect(calls.slice(1).every((c) => c.method === "editMessageText")).toBe(true)
    expect(calls.at(-1)!.text).toBe("Hi!")
  })

  test("the stop button interrupts the run and keeps the partial answer", async () => {
    const { emit, calls, state, view } = setup()
    emit("session.execution.started")
    emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "Partial" })
    await view.stop()
    expect(state.interrupted).toBe(1)
    await settle(600)
    expect(calls.length).toBe(0)
    emit("session.execution.interrupted", { reason: "user" })
    await settle()
    expect(sent(calls)).toEqual(["Partial\n\n⏹ Stopped"])
  })

  test("holds the final message back until the last draft has landed", async () => {
    const { emit, calls } = setup({ stored: [] })
    emit("session.execution.started")
    await settle(600)
    const draft = calls.at(-1)!
    expect(draft).toMatchObject({ method: "sendMessageDraft" })
    expect(draft.text).toMatch(/^✻ .+… 0s$/)
    emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "Ik ben Flint." })
    emit("session.execution.succeeded")
    await settle(100)
    expect(sent(calls)).toEqual([])
    await settle(FINAL_MS)
    const final = calls.find((c) => c.method === "sendMessage")!
    expect(final.text).toBe("Ik ben Flint.")
    expect(final.at - draft.at).toBeGreaterThanOrEqual(990)
    expect(calls.filter((c) => c.method === "sendMessageDraft").length).toBe(1)
  })

  test("sends the final message right away when no draft was shown", async () => {
    const { emit, calls } = setup({ stored: [] })
    emit("session.execution.started")
    emit("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: "Snel" })
    emit("session.execution.succeeded")
    await settle()
    expect(sent(calls)).toEqual(["Snel"])
  })
})
