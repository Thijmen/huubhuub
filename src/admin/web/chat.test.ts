import { describe, expect, test } from "bun:test"
import type { ChatMessage, Conversation } from "./api"
import { parseBlocks } from "./markdown"
import { applyEvent, mergeMessages } from "./pages/threads"

const base: Conversation = {
  session: { id: "s", title: null, model: null, agent: null, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, created: 0, updated: 0 },
  key: null,
  bot: null,
  busy: false,
  messages: [],
  older: null,
}

const run = (events: [string, Record<string, unknown>][]) => events.reduce((c, [type, data]) => applyEvent(c, { type, data }), base)

describe("chat event reducer", () => {
  test("streams text, reasoning and tools into one assistant message", () => {
    const c = run([
      ["session.execution.started", {}],
      ["session.step.started", { assistantMessageID: "a", agent: "build", model: { providerID: "p", id: "m" }, started: 1 }],
      ["session.reasoning.started", { assistantMessageID: "a", ordinal: 0 }],
      ["session.reasoning.delta", { assistantMessageID: "a", ordinal: 0, delta: "hmm" }],
      ["session.reasoning.ended", { assistantMessageID: "a", ordinal: 0, text: "hmm." }],
      ["session.tool.input.started", { assistantMessageID: "a", id: "t", name: "bash" }],
      ["session.tool.called", { assistantMessageID: "a", id: "t", input: { command: "ls" } }],
      ["session.tool.success", { assistantMessageID: "a", id: "t", content: [{ type: "text", text: "a.txt" }] }],
      ["session.text.delta", { assistantMessageID: "a", ordinal: 0, delta: "Hel" }],
      ["session.text.delta", { assistantMessageID: "a", ordinal: 0, delta: "lo" }],
      ["session.renamed", { title: "Listing" }],
    ])
    expect(c.busy).toBe(true)
    expect(c.session.title).toBe("Listing")
    const a = c.messages[0] as Extract<ChatMessage, { type: "assistant" }>
    expect(a.content.map((p) => p.type)).toEqual(["reasoning", "tool", "text"])
    expect(a.content[0]).toMatchObject({ text: "hmm." })
    expect(a.content[1]).toMatchObject({ state: { status: "completed", input: { command: "ls" } } })
    expect(a.content[2]).toMatchObject({ text: "Hello" })
    expect(applyEvent(c, { type: "session.execution.succeeded", data: {} }).busy).toBe(false)
  })

  test("ignores events for unknown messages", () => {
    expect(run([["session.text.delta", { assistantMessageID: "x", ordinal: 0, delta: "hi" }]]).messages).toEqual([])
  })
})

describe("mergeMessages", () => {
  test("dedupes by id, prefers the newer copy and keeps time order", () => {
    const m = (id: string, created: number, text = id) => ({ id, type: "user", text, time: { created } }) as ChatMessage
    const merged = mergeMessages([m("a", 1), m("b", 2)], [m("b", 2, "new"), m("c", 3)])
    expect(merged.map((x) => x.id)).toEqual(["a", "b", "c"])
    expect((merged[1] as { text: string }).text).toBe("new")
  })
})

describe("parseBlocks", () => {
  test("parses fences, lists, tables and paragraphs", () => {
    const blocks = parseBlocks("# Title\n\nsome *text*\nmore\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1\n```")
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "para", "list", "table", "code"])
    expect(blocks[2]).toMatchObject({ items: ["a", "b"], ordered: false })
    expect(blocks[3]).toMatchObject({ head: ["x", "y"], rows: [["1", "2"]] })
    expect(blocks[4]).toMatchObject({ lang: "ts", text: "const a = 1" })
  })

  test("keeps an unterminated fence as code while streaming", () => {
    expect(parseBlocks("```py\nprint(1)")).toEqual([{ kind: "code", lang: "py", text: "print(1)" }])
  })
})
