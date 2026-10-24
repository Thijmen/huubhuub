export interface CommandResult {
  /** null when the command was killed. */
  exitCode: number | null
  /** stdout and stderr interleaved; only the tail if it was long. */
  output: string
  timedOut: boolean
}

const OUTPUT_LIMIT = 64 * 1024
const KILL_GRACE_MS = 5_000
/** Background children can keep the pipe open after the shell exits; don't wait on them forever. */
const DRAIN_MS = 1_000

/** Run a command with bash in `cwd`, the way a scheduled command task does. */
export async function runCommand(
  command: string,
  opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number },
): Promise<CommandResult> {
  const proc = Bun.spawn(["bash", "-c", `exec 2>&1\n${command}`], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    // Its own process group, so a timeout also stops whatever the command started.
    detached: true,
  })
  let output = ""
  const decoder = new TextDecoder()
  const drained = (async () => {
    try {
      for await (const chunk of proc.stdout) {
        output += decoder.decode(chunk, { stream: true })
        if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT)
      }
    } catch {}
    output += decoder.decode()
  })()

  let timedOut = false
  let killer: ReturnType<typeof setTimeout> | undefined
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, signal)
    } catch {
      proc.kill(signal)
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill("SIGTERM")
    killer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS)
  }, opts.timeoutMs)

  const code = await proc.exited
  clearTimeout(timer)
  clearTimeout(killer)
  await Promise.race([drained, Bun.sleep(DRAIN_MS)])
  return { exitCode: proc.signalCode ? null : code, output: output.slice(-OUTPUT_LIMIT), timedOut }
}
