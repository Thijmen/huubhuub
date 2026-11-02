import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "../opencode"
import { AppEvents, lastSaid, plainText, previewOf, toAppMessages } from "./events"

const ev = (type: string, data: Record<string, unknown>) => ({ type, data: { sessionID: "s", ...data } }) as unknown as SessionEvent

describe("toAppMessages", () => {
  test("keeps what was said and drops bookkeeping", () => {
    const messages = [
      { id: "u1", type: "user", text: "Plan een weekendje weg", time: { created: 1 }, files: [{ name: "kaart.png", mime: "image/png", data: "AAAA" }, { name: "x.txt", mime: "text/plain", data: "eA==" }] },
      { id: "a1", type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "tool", id: "t1", name: "websearch", state: { status: "completed", input: { query: "Texel dit weekend" } } }, { type: "tool", id: "t2", name: "question", state: { status: "completed", input: {} } }, { type: "tool", id: "t3", name: "schedule_create", state: { status: "completed", input: { name: "Sterrenwacht   boeken", when: "at 09:00" } } }, { type: "tool", id: "t4", name: "memory_save", state: { status: "error", input: { text: "Houdt van Texel" } } }] },
      { id: "a2", type: "assistant", time: { created: 4, completed: 5 }, content: [{ type: "text", text: "## Texel" }, { type: "reasoning", text: "hmm" }, { type: "text", text: "Neem de boot." }] },
      { id: "m", type: "model-switched", time: { created: 6 } },
      { id: "a3", type: "assistant", time: { created: 7 }, content: [] },
      { id: "a4", type: "assistant", time: { created: 8, completed: 9 }, content: [], error: { message: "Rate limited" } },
    ]
    expect(toAppMessages(messages as never)).toEqual([
      { id: "u1", role: "user", createdAt: 1, text: "Plan een weekendje weg", images: [{ name: "kaart.png", uri: "data:image/png;base64,AAAA" }] },
      { id: "a1", role: "assistant", createdAt: 2, parts: [], tools: [
          { id: "t1", kind: "search", detail: "Texel dit weekend", status: "ok" },
          { id: "t3", kind: "other", detail: "schedule_create", status: "ok", note: { type: "reminder", text: "Sterrenwacht boeken" } },
          { id: "t4", kind: "other", detail: "memory_save", status: "error" },
        ],
        done: true, error: null },
      { id: "a2", role: "assistant", createdAt: 4, parts: ["## Texel", "Neem de boot."], done: true, error: null },
      { id: "a3", role: "assistant", createdAt: 7, parts: [], done: false, error: null },
      { id: "a4", role: "assistant", createdAt: 8, parts: [], done: true, error: "Rate limited" },
    ])
  })
})

describe("previews", () => {
  test("the last thing said, as plain text", () => {
    const msgs = toAppMessages([
      { id: "u", type: "user", text: "hoi", time: { created: 1 } },
      { id: "a", type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "text", text: "**Zeker!** Zie [de site](https://x.nl).\n\n```js\ncode()\n```" }] },
    ] as never)
    expect(previewOf(msgs)).toBe("Zeker! Zie de site.")
    expect(previewOf([])).toBeNull()
    expect(previewOf(msgs, 6)).toBe("Zeker…")
    expect(lastSaid(msgs)?.from).toBe("assistant")
    expect(lastSaid(msgs.slice(0, 1))).toEqual({ text: "hoi", from: "user" })
  })

  test("plainText flattens markdown", () => {
    expect(plainText("# Kop\n- een\n- `twee`\n> quote")).toBe("Kop een twee quote")
    expect(plainText("Lijst:\n- [ ] Eieren\n- [x] Koriander")).toBe("Lijst: Eieren Koriander")
    expect(plainText("_nadruk_ en __sterk__ in my_file_name.ts")).toBe("nadruk en sterk in my_file_name.ts")
  })
})

describe("AppEvents", () => {
  test("streams text and run state", () => {
    const m = new AppEvents()
    expect(m.map(ev("session.execution.started", {}))).toEqual({ type: "run.started" })
    expect(m.map(ev("session.text.delta", { assistantMessageID: "a", ordinal: 0, delta: "Hal" }))).toEqual({ type: "text", messageId: "a", ordinal: 0, delta: "Hal" })
    expect(m.map(ev("session.text.ended", { assistantMessageID: "a", ordinal: 0, text: "Hallo" }))).toEqual({ type: "text", messageId: "a", ordinal: 0, text: "Hallo" })
    expect(m.map(ev("session.execution.failed", { error: { message: "boom" } }))).toEqual({ type: "run.ended", outcome: "failed", error: "boom" })
    expect(m.map(ev("session.renamed", { title: "Texel" }))).toEqual({ type: "title", title: "Texel" })
    expect(m.map(ev("session.inbox.delivered", {}))).toEqual({ type: "refresh" })
    expect(m.map(ev("session.tool.input.delta", {}))).toBeUndefined()
  })

  test("describes tool calls, remembering their names", () => {
    const m = new AppEvents()
    expect(m.map(ev("session.tool.input.started", { id: "t", name: "websearch" }))).toEqual({ type: "activity", id: "t", kind: "search", detail: "", status: "running" })
    expect(m.map(ev("session.tool.called", { id: "t", input: { query: "weer Texel" } }))).toEqual({ type: "activity", id: "t", kind: "search", detail: "weer Texel", status: "running" })
    expect(m.map(ev("session.tool.success", { id: "t" }))).toMatchObject({ id: "t", kind: "search", status: "ok" })
    // Questions are shown as question cards, not activity.
    expect(m.map(ev("session.tool.input.started", { id: "q", name: "question" }))).toBeUndefined()
    expect(m.map(ev("session.tool.called", { id: "q", input: {} }))).toBeUndefined()
  })
})
