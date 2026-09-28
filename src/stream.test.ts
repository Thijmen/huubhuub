import { afterEach, describe, expect, test } from "bun:test"
import type { Api } from "grammy"
import type { Bridge, SessionEvent, TranscriptBlock } from "./opencode"
import { Questions } from "./question"
import { ChatView } from "./stream"

type Call = { method: string; text?: string; draftID?: number }

function fakeApi(opts: { draftsFail?: boolean } = {}) {
  const calls: Call[] = []
  let nextID = 100
  const api = {
    sendMessage: async (_chat: number, text: string) => (calls.push({ method: "sendMessage", text }), { message_id: nextID++ }),
    editMessageText: async (_chat: number, _id: number, text: string) => (calls.push({ method: "editMessageText", text }), true),
    sendMessageDraft: async (_chat: number, draftID: number, text: string) => {
      if (opts.draftsFail) throw new Error("Bad Request: method not available")
      calls.push({ method: "sendMessageDraft", text, draftID })
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
    const final = calls.at(-1)!.text!
    expect(final).toContain("webfetch: https://x.nl")
    expect(final).toContain("Het <b>nieuws</b>")
    expect(final).not.toContain("…")
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
    await settle()
    const drafts = calls.filter((c) => c.method === "sendMessageDraft")
    expect(drafts.map((d) => d.text)).toEqual(["Hel", "Hello"])
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
    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"])
    expect(calls.map((c) => c.text)).toEqual(["Hi\n\n…", "Hi"])
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
    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText", "editMessageText"])
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
})
