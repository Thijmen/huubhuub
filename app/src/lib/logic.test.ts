import { describe, expect, test } from "bun:test"
import type { ConversationPage } from "@server/protocol"
import { chatReducer, initialChat, type ChatState } from "./chat-state"
import { parseInvite } from "./invite"

describe("parseInvite", () => {
  test("reads the invite page link and the app link", () => {
    expect(parseInvite("https://huub.example.com/pair#abc123")).toEqual({ server: "https://huub.example.com", code: "abc123" })
    expect(parseInvite(" https://example.com/huub/pair/#abc ")).toEqual({ server: "https://example.com/huub", code: "abc" })
    expect(parseInvite("huubhuub://pair?server=https%3A%2F%2Fhuub.example.com%2F&code=xyz")).toEqual({ server: "https://huub.example.com", code: "xyz" })
  })

  test("rejects anything else", () => {
    for (const bad of ["", "hello", "https://huub.example.com/pair", "https://huub.example.com/other#abc", "huubhuub://pair?code=x", "huubhuub://pair?server=javascript:alert(1)&code=x", "ftp://x/pair#a"]) {
      expect(parseInvite(bad)).toBeNull()
    }
  })
})

const page = (over: Partial<ConversationPage> = {}): ConversationPage => ({
  conversation: { id: "c", title: "Texel", updatedAt: 1, busy: false, preview: null, telegram: false },
  messages: [{ id: "u1", role: "user", createdAt: 1, text: "Plan een weekend", images: [] }],
  older: "cursor1",
  question: null,
  ...over,
})

const run = (s: ChatState, ...events: Parameters<typeof chatReducer>[1][]) => events.reduce(chatReducer, s)

describe("chatReducer", () => {
  test("streams a reply into a new message and finishes it", () => {
    let s = chatReducer(initialChat, { type: "page", page: page() })
    s = run(
      s,
      { type: "event", event: { type: "run.started" } },
      { type: "event", event: { type: "activity", id: "t", kind: "search", detail: "Texel", status: "running" } },
      { type: "event", event: { type: "text", messageId: "a1", ordinal: 0, delta: "Neem " } },
      { type: "event", event: { type: "text", messageId: "a1", ordinal: 0, delta: "de boot" } },
      { type: "event", event: { type: "text", messageId: "a1", ordinal: 1, text: "Fijn weekend!" } },
    )
    expect(s.busy).toBe(true)
    expect(s.activity).toEqual({ id: "t", kind: "search", detail: "Texel" })
    expect(s.messages.at(-1)).toMatchObject({ id: "a1", role: "assistant", parts: ["Neem de boot", "Fijn weekend!"], done: false })
    s = run(s, { type: "event", event: { type: "activity", id: "t", kind: "search", detail: "", status: "ok" } })
    expect(s.activity).toBeNull()
    s = run(s, { type: "event", event: { type: "run.ended", outcome: "failed", error: "No credit" } })
    expect(s).toMatchObject({ busy: false, failure: "No credit" })
    expect(s.messages.at(-1)).toMatchObject({ done: true })
  })

  test("a message typed here shows until the server has it", () => {
    let s = chatReducer(initialChat, { type: "page", page: page() })
    s = chatReducer(s, { type: "pending", pending: { id: "local-1", text: "En zondag?", images: [], createdAt: 5 } })
    expect(s.pending).toHaveLength(1)
    s = chatReducer(s, { type: "page", page: page({ messages: [...page().messages, { id: "u2", role: "user", createdAt: 6, text: "En zondag?", images: [] }] }) })
    expect(s.pending).toHaveLength(0)
    expect(s.messages.map((m) => m.id)).toEqual(["u1", "u2"])
  })

  test("older pages merge in front without resetting state", () => {
    let s = chatReducer(initialChat, { type: "page", page: page() })
    s = chatReducer(s, { type: "page", older: true, page: page({ messages: [{ id: "u0", role: "user", createdAt: 0, text: "Eerder", images: [] }], older: null }) })
    expect(s.messages.map((m) => m.id)).toEqual(["u0", "u1"])
    expect(s.older).toBeNull()
    // A later refresh of the latest page keeps the older cursor where it was.
    s = chatReducer(s, { type: "page", page: page() })
    expect(s.older).toBeNull()
  })

  test("only open questions are shown", () => {
    const q = { formID: "f", status: "pending" as const, index: 0, total: 1, fields: [], selected: [], answers: [], expiresAt: 0 }
    let s = chatReducer(initialChat, { type: "event", event: { type: "question", question: q } })
    expect(s.question?.formID).toBe("f")
    s = chatReducer(s, { type: "event", event: { type: "question", question: { ...q, status: "answered" } } })
    expect(s.question).toBeNull()
  })
})
