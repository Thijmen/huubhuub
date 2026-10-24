import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { InternalApi } from "../internal"
import plugin from "./index"

type Tool = { name: string; input: { required?: readonly string[] }; execute: (input: unknown, context: { sessionID: string; signal: AbortSignal }) => Promise<{ content?: unknown }> }

const internal = new InternalApi()
const calls: { op: string; sessionID: string; input: Record<string, unknown> }[] = []
const tools = new Map<string, Tool>()
let shellHook: ((event: { cwd: string; env: Record<string, string | undefined> }) => Promise<void>) | undefined
type Request = { sessionID: string; system: { type: "text"; text: string }[]; tools: Record<string, unknown> }
let contextHook: ((request: Request) => Promise<void>) | undefined
const memoryCalls: { op: string; sessionID: string; input: Record<string, unknown> }[] = []
const saved = { url: process.env.BOT_INTERNAL_URL, token: process.env.BOT_INTERNAL_TOKEN, gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN }

beforeAll(async () => {
  internal.attach({
    github: { token: async (q: { cwd?: string }) => (q.cwd === "/repo" ? "tok-repo" : null) } as never,
    schedules: {
      call: async (op: string, sessionID: string, input: Record<string, unknown>) => {
        if (input.id === 99) throw new (await import("../schedule-spec")).SpecError("There's no schedule #99 here.")
        calls.push({ op, sessionID, input })
        return `did ${op}`
      },
    } as never,
    personas: {
      context: (sessionID: string) =>
        sessionID === "ses_huub" ? { system: "# Persona\nJe bent Huub.", memory: true } : sessionID === "ses_nomem" ? { system: "# Persona\nJe bent Huub.", memory: false } : { system: null, memory: false },
      agentMemory: (op: string, sessionID: string, input: Record<string, unknown>) => {
        memoryCalls.push({ op, sessionID, input })
        return `memory ${op}`
      },
    },
  })
  Object.assign(process.env, { BOT_INTERNAL_URL: internal.url, BOT_INTERNAL_TOKEN: internal.token })
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  const ctx = {
    tool: { transform: async (cb: (editor: { add: (t: Tool) => void }) => void) => cb({ add: (t) => void tools.set(t.name, t) }) },
    shell: { hook: async (_name: string, cb: typeof shellHook) => void (shellHook = cb) },
    session: { hook: async (name: string, cb: typeof contextHook) => void (name === "context" && (contextHook = cb)) },
  }
  await plugin.setup(ctx as never)
})

afterAll(() => {
  internal.stop()
  for (const [k, v] of Object.entries({ BOT_INTERNAL_URL: saved.url, BOT_INTERNAL_TOKEN: saved.token, GH_TOKEN: saved.gh, GITHUB_TOKEN: saved.github })) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("agent plugin", () => {
  test("registers the memory and schedule tools", () => {
    expect([...tools.keys()]).toEqual(["memory_save", "memory_update", "memory_forget", "schedule_list", "schedule_create", "schedule_update", "schedule_delete", "schedule_run"])
    expect(tools.get("schedule_create")!.input.required).toEqual(["when"])
  })

  test("tools call the bot with the session they run in", async () => {
    const out = await tools.get("schedule_create")!.execute({ when: "every 1h", prompt: "hi" }, { sessionID: "ses_1", signal: new AbortController().signal })
    expect(out.content).toBe("did create")
    expect(calls.at(-1)).toEqual({ op: "create", sessionID: "ses_1", input: { when: "every 1h", prompt: "hi", sessionID: "ses_1" } })
  })

  test("memory tools call the bot with the session they run in", async () => {
    const out = await tools.get("memory_save")!.execute({ text: "Has a dog" }, { sessionID: "ses_huub", signal: new AbortController().signal })
    expect(out.content).toBe("memory save")
    expect(memoryCalls.at(-1)).toEqual({ op: "save", sessionID: "ses_huub", input: { text: "Has a dog", sessionID: "ses_huub" } })
  })

  test("adds the persona to the system prompt and hides memory tools where memory is off", async () => {
    const request = (sessionID: string): Request => ({
      sessionID,
      system: [{ type: "text", text: "You are opencode." }],
      tools: { bash: {}, memory_save: {}, memory_update: {}, memory_forget: {}, schedule_list: {} },
    })
    const huub = request("ses_huub")
    await contextHook!(huub)
    expect(huub.system.map((p) => p.text)).toEqual(["You are opencode.", "# Persona\nJe bent Huub."])
    expect(Object.keys(huub.tools)).toContain("memory_save")

    const noMemory = request("ses_nomem")
    await contextHook!(noMemory)
    expect(noMemory.system).toHaveLength(2)
    expect(Object.keys(noMemory.tools)).toEqual(["bash", "schedule_list"])

    const foreign = request("ses_webui")
    await contextHook!(foreign)
    expect(foreign.system).toHaveLength(1)
    expect(Object.keys(foreign.tools)).toEqual(["bash", "schedule_list"])
  })

  test("errors from the bot reach the model", async () => {
    await expect(tools.get("schedule_delete")!.execute({ id: 99 }, { sessionID: "ses_1", signal: new AbortController().signal })).rejects.toThrow("no schedule #99")
  })

  test("shell commands get GH_TOKEN for their checkout, unless one is set", async () => {
    const event = { cwd: "/repo", env: {} as Record<string, string | undefined> }
    await shellHook!(event)
    expect(event.env.GH_TOKEN).toBe("tok-repo")
    const elsewhere = { cwd: "/tmp", env: {} as Record<string, string | undefined> }
    await shellHook!(elsewhere)
    expect(elsewhere.env.GH_TOKEN).toBeUndefined()
    const own = { cwd: "/repo", env: { GH_TOKEN: "mine" } as Record<string, string | undefined> }
    await shellHook!(own)
    expect(own.env.GH_TOKEN).toBe("mine")
  })
})
