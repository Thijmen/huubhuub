import { describe, expect, test } from "bun:test"
import { innerTools, summariseTools } from "./chat"

const tool = (id: string, name: string, input: Record<string, unknown>, status: "completed" | "error" = "completed") => ({
  type: "tool",
  id,
  name,
  state: status === "error" ? { status, input, error: { type: "x", message: "boom" } } : { status, input, content: [] },
  time: { created: 1 },
})
const assistant = (id: string, ...content: unknown[]) => ({ type: "assistant", id, content, time: { created: 1 } })

describe("tool calls", () => {
  test("finds the tools a Code Mode script calls", () => {
    expect(innerTools({ code: 'await tools.memory_save({ text: "x" })\nconst r = await tools.opencode.session_rename({ title: "t" })' })).toEqual(["memory_save", "session_rename"])
    expect(innerTools({ code: 'tools.github["create-issue"]({})' })).toEqual(["create-issue"])
    expect(innerTools({ code: "return 1 + 1" })).toEqual([])
    expect(innerTools(undefined)).toEqual([])
  })

  test("tallies calls per tool, newest first, counting what execute ran", () => {
    const messages = [
      assistant("m2", tool("t3", "shell", { command: "ls" }, "error"), tool("t4", "execute", { code: "await tools.memory_save({})" })),
      { type: "user", id: "u1", text: "hi", time: { created: 1 } },
      assistant("m1", tool("t1", "shell", { command: "pwd" }), { type: "text", text: "ok" }, tool("t2", "read", { filePath: "/a" })),
    ]
    const out = summariseTools(messages as never)
    expect(out.total).toBe(4)
    expect(out.tally).toEqual([
      { name: "shell", count: 2, errors: 1 },
      { name: "memory_save", count: 1, errors: 0 },
      { name: "read", count: 1, errors: 0 },
    ])
    expect(out.calls.map((c) => (c.part as { id: string }).id)).toEqual(["t4", "t3", "t2", "t1"])
    expect(out.calls[0]!.inner).toEqual(["memory_save"])
  })
})
