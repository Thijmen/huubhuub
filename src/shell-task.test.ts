import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCommand } from "./shell-task"

const opts = { cwd: tmpdir(), env: process.env, timeoutMs: 10_000 }
const dir = mkdtempSync(join(tmpdir(), "shell-task-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("runCommand", () => {
  test("collects stdout and stderr in order, with the exit code", async () => {
    const r = await runCommand("echo one; echo two >&2; echo three; exit 3", opts)
    expect(r).toEqual({ exitCode: 3, output: "one\ntwo\nthree\n", timedOut: false })
  })

  test("runs in the given directory with the given environment", async () => {
    const r = await runCommand('pwd; echo "$TASK_VAR"', { ...opts, env: { ...process.env, TASK_VAR: "hello" } })
    expect(r.output).toContain("hello")
    expect(r.exitCode).toBe(0)
  })

  test("kills a command that runs too long, with everything it started", async () => {
    const started = Date.now()
    const r = await runCommand("echo start; sleep 30 & echo $! > pid; wait", { ...opts, cwd: dir, timeoutMs: 300 })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBeNull()
    expect(r.output).toBe("start\n")
    expect(Date.now() - started).toBeLessThan(5000)
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"))
    await Bun.sleep(100)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test("keeps only the tail of huge output", async () => {
    const r = await runCommand("head -c 300000 /dev/zero | tr '\\0' a; echo END", opts)
    expect(r.output.length).toBeLessThanOrEqual(64 * 1024)
    expect(r.output).toEndWith("END\n")
  })
})
