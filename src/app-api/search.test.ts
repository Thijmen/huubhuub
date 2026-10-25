import { describe, expect, test } from "bun:test"
import { ConversationSearch, fold, snippet } from "./search"

const msg = (id: string, type: "user" | "assistant", text: string, created: number) =>
  type === "user" ? { id, type, text, time: { created } } : { id, type, time: { created, completed: created + 1 }, content: [{ type: "text", text }] }

describe("ConversationSearch", () => {
  test("finds the newest matching message, then titles, and caches until a conversation changes", async () => {
    let calls = 0
    const data: Record<string, unknown[]> = {
      a: [msg("a2", "assistant", "Een **recept** voor pannenkoeken met appel", 2), msg("a1", "user", "Heb je een recept?", 1)],
      b: [msg("b1", "user", "Plan een weekend naar Texel", 1)],
    }
    const search = new ConversationSearch(async (id) => (calls++, { data: data[id] as never, cursor: {} }))
    const convs = [
      { sessionID: "a", title: "Koken", updated: 1 },
      { sessionID: "b", title: "Weekendje Café", updated: 1 },
    ]
    expect(await search.search("RECEPT", convs)).toEqual([{ sessionID: "a", snippet: "Een recept voor pannenkoeken met appel", messageId: "a2" }])
    expect(await search.search("cafe", convs)).toEqual([{ sessionID: "b", snippet: null, messageId: null }])
    expect(calls).toBe(2)
    await search.search("texel", [{ ...convs[1]!, updated: 2 }])
    expect(calls).toBe(3)
    expect(await search.search("t", convs)).toEqual([])
  })

  test("folding and snippets", () => {
    expect(fold("Crème Brûlée")).toBe("creme brulee")
    const long = `${"woord ".repeat(30)}Texel ${"meer ".repeat(30)}`
    const s = snippet(long, "texel")
    expect(s.startsWith("…")).toBe(true)
    expect(s.endsWith("…")).toBe(true)
    expect(s).toContain("Texel")
    expect(s.length).toBeLessThan(140)
  })
})
