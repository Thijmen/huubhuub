import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { Api } from "grammy"
import { commandReport, ScheduleRunner, withPrecheck, type RunnerDeps } from "./schedule-runner"
import type { Schedule } from "./store"

const base: Schedule = {
  id: 1,
  chatId: 42,
  name: "disk",
  kind: "interval",
  spec: "every 1h",
  type: "command",
  prompt: "",
  command: "echo hi",
  model: null,
  agent: null,
  silent: false,
  paused: false,
  failStreak: 0,
  nextAt: 0,
  createdBy: "user",
  createdAt: 0,
}

function runner(over: Partial<RunnerDeps> = {}) {
  const sent: { chatId: number; text: string }[] = []
  const api = { sendMessage: async (chatId: number, text: string) => void sent.push({ chatId, text }) } as unknown as Api
  const deps = {
    api,
    bridge: {
      createDetached: async () => {
        throw new Error("no session expected")
      },
    },
    chats: {},
    questions: {},
    timeZone: () => "UTC",
    allowedUsers: () => [7, 8],
    workspace: tmpdir(),
    commandEnv: async () => process.env,
    ...over,
  } as unknown as RunnerDeps
  return { runner: new ScheduleRunner(deps), sent }
}

describe("ScheduleRunner", () => {
  test("a command task posts its output and has no session", async () => {
    const { runner: r, sent } = runner()
    const run = await r.start(base, 0)
    expect(run.sessionID).toBeNull()
    expect(await run.done).toEqual({ status: "ok", output: "hi\n" })
    expect(sent).toEqual([{ chatId: 42, text: "⚙️ <b>disk</b> ✅\n<pre>hi</pre>" }])
  })

  test("a failing command counts as a failed run", async () => {
    const { runner: r, sent } = runner()
    const outcome = await (await r.start({ ...base, command: "echo nope; exit 2" }, 0)).done
    expect(outcome).toMatchObject({ status: "failed", error: "The command exited with code 2.", output: "nope\n" })
    expect(sent[0]!.text).toContain("⚠️ exit 2")
  })

  test("silent commands only post when they print something", async () => {
    const { runner: r, sent } = runner()
    expect((await (await r.start({ ...base, silent: true, command: "true" }, 0)).done).status).toBe("silent")
    expect(sent).toHaveLength(0)
    await (await r.start({ ...base, silent: true }, 0)).done
    expect(sent).toHaveLength(1)
  })

  test("a prompt in a private chat is skipped while its person is over their spending limit", async () => {
    const checked: number[] = []
    const { runner: r, sent } = runner({
      spendBlocked: async (id) => {
        checked.push(id)
        return "⛔ You've reached today's spending limit of $5.00."
      },
    })
    const run = await r.start({ ...base, type: "prompt", prompt: "Summarise the news", command: null }, 0)
    expect(run.sessionID).toBeNull()
    expect(await run.done).toEqual({ status: "skipped", error: "⛔ You've reached today's spending limit of $5.00." })
    expect(checked).toEqual([42])
    expect(sent[0]!.text).toBe("⏭ Skipped <b>disk</b>. ⛔ You've reached today's spending limit of $5.00.")
  })

  test("commands and group chats aren't held to spending limits", async () => {
    const spendBlocked = async () => "blocked"
    const { runner: r } = runner({ spendBlocked })
    expect((await (await r.start(base, 0)).done).status).toBe("ok")
    const group = await r.start({ ...base, chatId: -100, type: "prompt", prompt: "hi", command: null }, 0).catch((e: Error) => e.message)
    expect(group).toBe("no session expected")
  })

  test("background commands post nothing", async () => {
    const { runner: r, sent } = runner()
    expect((await (await r.start({ ...base, chatId: null }, 0)).done).status).toBe("ok")
    expect(sent).toHaveLength(0)
  })

  test("commands get the environment from commandEnv", async () => {
    const { runner: r } = runner({ commandEnv: async () => ({ ...process.env, GH_TOKEN: "tok" }) })
    expect((await (await r.start({ ...base, command: 'echo "$GH_TOKEN"' }, 0)).done).output).toBe("tok\n")
  })

  test("a pre-check that prints nothing skips the prompt; one that fails fails the run", async () => {
    const { runner: r } = runner()
    const prompt = { ...base, type: "prompt" as const, prompt: "review these", command: "true" }
    const quiet = await r.start(prompt, 0)
    expect(quiet.sessionID).toBeNull()
    expect(await quiet.done).toEqual({ status: "silent", output: "" })
    expect(await (await r.start({ ...prompt, command: "exit 1" }, 0)).done).toMatchObject({ status: "failed", error: "The pre-check exited with code 1." })
  })

  test("background job alerts go to every allowlisted user", async () => {
    const { runner: r, sent } = runner()
    await r.notify(null, "paused")
    expect(sent.map((m) => m.chatId)).toEqual([7, 8])
  })
})

describe("formatting", () => {
  test("withPrecheck appends the command output", () => {
    expect(withPrecheck("Review them.", "gh pr list", "#1 fix\n")).toBe("Review them.\n\nOutput of `gh pr list`:\n```\n#1 fix\n```")
  })

  test("commandReport escapes and trims long output", () => {
    const text = commandReport(base, { exitCode: 0, output: `<b>${"x".repeat(5000)}`, timedOut: false })
    expect(text).not.toContain("<b>x")
    expect(text.length).toBeLessThan(3700)
    expect(commandReport(base, { exitCode: null, output: "", timedOut: true })).toContain("timed out")
  })
})
