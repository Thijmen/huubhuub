import { OpenCode, type OpenCodeClient } from "@opencode/client"
import type { Subprocess } from "bun"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "./config"

const READY_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 10_000
const MAX_BACKOFF_MS = 30_000
const BINARY = join(import.meta.dir, "..", "node_modules", ".bin", "opencode")

export type ServerStatus = "starting" | "running" | "restarting" | "stopped"

/**
 * Runs `opencode serve` as a child process. Every bot session lives in it, and it also serves the
 * OpenCode web UI on its own port, so the same sessions can be inspected from a browser.
 */
export class OpenCodeServer {
  readonly client: OpenCodeClient
  status: ServerStatus = "stopped"
  version: string | null = null
  startedAt: number | null = null
  restarts = 0
  /** Runs after every successful (re)start, before the server counts as running. */
  onReady: () => Promise<void> = async () => {}

  private proc?: Subprocess<"ignore", "pipe", "pipe">
  private stopping = false
  private transition?: Promise<void>
  private backoff = 1000
  private readonly pidFile: string
  private readonly connectHost: string

  constructor(
    private readonly config: Config,
    private readonly password: string,
    private readonly configContent: string,
  ) {
    this.connectHost = ["0.0.0.0", "::", ""].includes(config.OPENCODE_HOST) ? "127.0.0.1" : config.OPENCODE_HOST
    this.client = OpenCode.make({ baseUrl: `http://${this.connectHost}:${config.OPENCODE_PORT}`, headers: { authorization: basicAuth(password) } })
    this.pidFile = join(config.DATA_DIR, "opencode-server.pid")
    process.on("exit", () => this.proc?.kill("SIGKILL"))
  }

  start(): Promise<void> {
    return this.run(() => this.boot())
  }

  /** Restart with the current process environment, e.g. after env vars changed in the admin UI. */
  restart(): Promise<void> {
    return this.run(async () => {
      this.status = "restarting"
      await this.halt()
      await this.boot()
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.transition?.catch(() => {})
    await this.halt()
    this.status = "stopped"
  }

  /** A single-use link that signs a browser into the OpenCode web UI. */
  async pairingLink(publicUrl: string): Promise<string> {
    const { code } = await this.client.server.pair()
    return new URL(`/auth/connect/${encodeURIComponent(code)}`, publicUrl).toString()
  }

  private run(fn: () => Promise<void>): Promise<void> {
    const next = (this.transition ?? Promise.resolve()).catch(() => {}).then(fn)
    this.transition = next
    return next
  }

  private async boot(): Promise<void> {
    this.status = this.restarts === 0 && !this.startedAt ? "starting" : "restarting"
    await killStale(this.pidFile)
    const { OPENCODE_HOST: host, OPENCODE_PORT: port } = this.config
    if (await portInUse(this.connectHost, port)) {
      throw new Error(`Port ${port} is already in use by another program (another OpenCode or Kilo server?). Set OPENCODE_PORT to a free port.`)
    }
    const proc = Bun.spawn(
      [BINARY, "serve", "--hostname", host, "--port", String(port), "--log-level", this.config.OPENCODE_LOG_LEVEL, "--print-logs"],
      {
        cwd: this.config.WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: this.password,
          OPENCODE_CONFIG_CONTENT: this.configContent,
          OPENCODE_DB: join(this.config.DATA_DIR, "opencode.sqlite"),
          OPENCODE_DISABLE_AUTOUPDATE: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    this.proc = proc
    writeFileSync(this.pidFile, String(proc.pid))
    const tail: string[] = []
    void pipeLines(proc.stdout, (line) => console.log(`[opencode] ${line}`))
    void pipeLines(proc.stderr, (line) => {
      tail.push(line)
      if (tail.length > 20) tail.shift()
      console.error(`[opencode] ${line}`)
    })
    void proc.exited.then((code) => this.exited(proc, code))

    try {
      this.version = (await this.waitReady(proc)).version
      await this.onReady()
    } catch (err) {
      this.proc = undefined
      proc.kill("SIGKILL")
      throw new Error(`${(err as Error).message}${tail.length ? `\n${tail.join("\n")}` : ""}`)
    }
    this.status = "running"
    this.startedAt = Date.now()
    this.backoff = 1000
  }

  private async waitReady(proc: Subprocess): Promise<{ version: string }> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`opencode serve exited (${proc.exitCode ?? proc.signalCode}) during startup`)
      const info = await this.client.server.info({ signal: AbortSignal.timeout(2000) }).catch(() => undefined)
      // macOS lets another program hold 127.0.0.1 on the same port while we bind 0.0.0.0; make sure it's our child answering.
      if (info && info.pid !== proc.pid) throw new Error(`Another server (pid ${info.pid}) answered on port ${this.config.OPENCODE_PORT}. Set OPENCODE_PORT to a free port.`)
      if (info) return info
      await Bun.sleep(250)
    }
    throw new Error(`opencode serve did not become ready within ${READY_TIMEOUT_MS / 1000}s`)
  }

  /** Stop the current child and wait for it to release the port. */
  private async halt(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.proc = undefined
    proc.kill("SIGTERM")
    const timer = setTimeout(() => proc.kill("SIGKILL"), STOP_TIMEOUT_MS)
    await proc.exited
    clearTimeout(timer)
    rmSync(this.pidFile, { force: true })
  }

  /** The child died on its own: bring it back with backoff so a crash loop doesn't spin. */
  private exited(proc: Subprocess, code: number | null): void {
    if (this.stopping || this.proc !== proc) return
    this.proc = undefined
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    console.error(`opencode serve exited unexpectedly (${code ?? proc.signalCode}); restarting in ${delay / 1000}s`)
    this.status = "restarting"
    this.restarts++
    void this.run(async () => {
      await Bun.sleep(delay)
      if (!this.stopping) await this.boot()
    }).catch((err) => {
      console.error("opencode serve failed to restart", err)
      if (!this.stopping && !this.proc) this.exited(proc, code)
    })
  }
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

async function portInUse(hostname: string, port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname, port, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

async function pipeLines(stream: ReadableStream<Uint8Array>, write: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trimEnd()
        buffer = buffer.slice(nl + 1)
        if (line) write(line)
      }
    }
  } catch {}
  if (buffer.trim()) write(buffer.trim())
}

/** A previous bot process that died hard (or `bun --watch` restarting) can leave its server holding the port. */
async function killStale(pidFile: string): Promise<void> {
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, "utf8").trim())
  rmSync(pidFile, { force: true })
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !isOpenCodeServe(pid)) return
  console.warn(`Stopping a leftover opencode server (pid ${pid})`)
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline && alive(pid)) await Bun.sleep(100)
  if (alive(pid)) process.kill(pid, "SIGKILL")
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // `bun --watch` restarts in place, so a stopped server from the previous run stays our unreaped child: a zombie.
  return !processState(pid).startsWith("Z")
}

function processState(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3)
  } catch {
    return Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stderr: "ignore" }).stdout.toString().trim()
  }
}

function isOpenCodeServe(pid: number): boolean {
  if (!alive(pid)) return false
  let cmd = ""
  try {
    cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ")
  } catch {
    const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stderr: "ignore" })
    cmd = ps.stdout.toString()
  }
  return cmd.includes("opencode") && cmd.includes("serve")
}
