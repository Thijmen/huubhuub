import { describe, expect, mock, test } from "bun:test"
import type { AppMessage, ConversationPage } from "@server/protocol"
import { chatReducer, initialChat, type ChatState } from "./chat-state"
import { topicOf } from "./topic"

// i18n reads the phone's language through a native module.
mock.module("expo-localization", () => ({ getLocales: () => [{ languageCode: "en" }] }))
const { itemsOf } = await import("./chat-items")

const DAY = 86_400_000
const now = Date.now()
const user = (id: string, at: number, text = "hoi"): AppMessage => ({ id, role: "user", createdAt: at, text, images: [] })
const huub = (id: string, at: number, text: string, tools: Extract<AppMessage, { role: "assistant" }>["tools"] = undefined): AppMessage => ({
  id,
  role: "assistant",
  createdAt: at,
  parts: text ? [text] : [],
  ...(tools ? { tools } : {}),
  done: true,
  error: null,
})
const tool = (id: string, note?: { type: "reminder" | "memory"; text: string }) => ({ id, kind: "search" as const, detail: "texel", status: "ok" as const, ...(note ? { note } : {}) })
const chat = (over: Partial<ChatState>): ChatState => ({ ...initialChat, loaded: true, ...over })

describe("itemsOf", () => {
  test("day labels, tools above the reply, and the avatar on the first of a run", () => {
    const items = itemsOf(
      chat({
        messages: [
          user("u1", now - DAY),
          huub("a1", now - DAY + 1, "", [tool("t1")]),
          huub("a2", now - DAY + 2, "Zeker!", [tool("t2")]),
          huub("a3", now - DAY + 3, "En nog iets"),
          user("u2", now),
        ],
      }),
    )
    expect(items.map((i) => i.kind)).toEqual(["day", "user", "tools", "huub", "huub", "day", "user"])
    expect(items[0]).toMatchObject({ label: "Yesterday" })
    expect(items[2]).toMatchObject({ tools: [{ id: "t1" }, { id: "t2" }] })
    expect(items.filter((i) => i.kind === "huub").map((i) => (i as { showAvatar: boolean }).showAvatar)).toEqual([true, false])
    expect(items[5]).toMatchObject({ label: "Today" })
  })

  test("reminders go inside the reply that follows; tools at the end still show", () => {
    const items = itemsOf(chat({ messages: [user("u1", now), huub("a1", now + 1, "", [tool("t1", { type: "reminder", text: "Bellen" })]), huub("a2", now + 2, "Komt goed"), user("u2", now + 3), huub("a3", now + 4, "", [tool("t3")])] }))
    expect(items.map((i) => i.kind)).toEqual(["day", "user", "huub", "user", "tools"])
    expect(items[2]).toMatchObject({ notes: [{ id: "t1" }] })
  })

  test("this reply's tools sit after the question, without the ones the server already sent", () => {
    const streaming: AppMessage = { id: "a2", role: "assistant", createdAt: now + 2, parts: ["Even kijken"], done: false, error: null }
    const items = itemsOf(
      chat({
        busy: true,
        messages: [user("u1", now), huub("a1", now + 1, "", [tool("t1")]), streaming],
        tools: [tool("t1"), { id: "t2", kind: "web", detail: "teso.nl", status: "running" }],
      }),
    )
    expect(items.map((i) => i.kind)).toEqual(["day", "user", "tools", "tools", "huub"])
    expect(items[3]).toMatchObject({ id: "live-tools", live: true, tools: [{ id: "t2" }] })
  })
})

describe("live tools", () => {
  const page = (busy: boolean): ConversationPage => ({
    conversation: { id: "s", title: null, updatedAt: 0, busy, preview: null, telegram: false, pinned: false, archived: false },
    messages: [],
    older: null,
    question: null,
  })

  test("collects a reply's tool calls and keeps the detail from the call", () => {
    let s = chatReducer(initialChat, { type: "event", event: { type: "run.started" } })
    s = chatReducer(s, { type: "event", event: { type: "activity", id: "t1", kind: "search", detail: "", status: "running" } })
    s = chatReducer(s, { type: "event", event: { type: "activity", id: "t1", kind: "search", detail: "Texel", status: "running" } })
    s = chatReducer(s, { type: "event", event: { type: "activity", id: "t1", kind: "search", detail: "", status: "ok" } })
    expect(s.tools).toEqual([{ id: "t1", kind: "search", detail: "Texel", status: "ok" }])
    expect(s.activity).toBeNull()
    expect(chatReducer(s, { type: "page", page: page(true) }).tools).toHaveLength(1)
    expect(chatReducer(s, { type: "page", page: page(false) }).tools).toEqual([])
    expect(chatReducer(s, { type: "event", event: { type: "run.started" } }).tools).toEqual([])
  })
})

describe("topicOf", () => {
  test("uses an emoji the title starts with", () => {
    expect(topicOf("🌊 Weekendje Texel", "a")).toMatchObject({ emoji: "🌊", title: "Weekendje Texel", letter: "W" })
    expect(topicOf("👩‍🍳 Koken", "a")).toMatchObject({ emoji: "👩‍🍳", title: "Koken" })
  })

  test("picks one for common topics, in Dutch and English", () => {
    expect(topicOf("Boodschappenlijst", "a").emoji).toBe("🛒")
    expect(topicOf("Herinnering tandarts", "a").emoji).toBe("🦷")
    expect(topicOf("Huiswerk wiskunde", "a").emoji).toBe("🎒")
    expect(topicOf("Grocery list", "a").emoji).toBe("🛒")
    expect(topicOf("Birthday party", "a").emoji).toBe("🎂")
  })

  test("falls back to the first letter, and a tint that stays the same", () => {
    expect(topicOf("Over de grens", "a")).toMatchObject({ emoji: null, letter: "O" })
    expect(topicOf(null, "a")).toMatchObject({ emoji: null, letter: "H", title: "" })
    expect(topicOf("x", "ses_1").tint).toBe(topicOf("y", "ses_1").tint)
  })
})
