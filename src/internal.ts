import { randomBytes, timingSafeEqual } from "node:crypto"
import type { AgentScheduleInput, AgentSchedules } from "./agent-schedules"
import type { GitHubAccess } from "./github-access"
import { MemoryError, type Personas } from "./personas"
import { SpecError } from "./schedule-spec"
import { SkillError } from "./skills"

export interface InternalDeps {
  github: GitHubAccess
  schedules: AgentSchedules
  personas: Pick<Personas, "context" | "agentMemory">
}

/**
 * A loopback-only API for processes the bot starts: the OpenCode plugin (schedule and memory tools, the
 * persona and memories for the system prompt, `gh` tokens) and
 * the git credential helper. It starts before OpenCode so its address can go into OpenCode's environment;
 * the services behind it are attached once they exist.
 */
export class InternalApi {
  readonly token = randomBytes(24).toString("base64url")
  private deps?: InternalDeps
  private readonly server: Bun.Server<undefined>

  constructor() {
    const guard = (handler: (req: Bun.BunRequest, deps: InternalDeps) => Promise<Response>) => async (req: Bun.BunRequest) => {
      if (!this.authorised(req)) return Response.json({ error: "Unauthorised" }, { status: 401 })
      if (!this.deps) return Response.json({ error: "The bot is still starting." }, { status: 503 })
      try {
        return await handler(req, this.deps)
      } catch (err) {
        const known = err instanceof SpecError || err instanceof SkillError || err instanceof MemoryError
        if (!known) console.error(`internal ${req.method} ${new URL(req.url).pathname} failed`, err)
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: known ? 400 : 500 })
      }
    }

    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: {
        "/github/token": {
          GET: guard(async (req, d) => {
            const q = new URL(req.url).searchParams
            const token = await d.github.token({ owner: q.get("owner") ?? undefined, cwd: q.get("cwd") ?? undefined, strict: q.get("strict") === "1" })
            return token ? new Response(token, { headers: { "content-type": "text/plain" } }) : new Response(null, { status: 204 })
          }),
        },
        "/agent/context": {
          GET: guard(async (req, d) => {
            const sessionID = new URL(req.url).searchParams.get("sessionID")
            if (!sessionID) throw new SpecError("Missing sessionID.")
            return Response.json(d.personas.context(sessionID))
          }),
        },
        "/agent/memory/:op": {
          POST: guard(async (req, d) => {
            const body = (await req.json().catch(() => ({}))) as { sessionID?: string; id?: number; text?: string }
            if (!body.sessionID) throw new SpecError("Missing sessionID.")
            return Response.json({ text: d.personas.agentMemory(req.params.op ?? "", body.sessionID, body) })
          }),
        },
        "/agent/schedules/:op": {
          POST: guard(async (req, d) => {
            const body = (await req.json().catch(() => ({}))) as AgentScheduleInput & { sessionID?: string }
            if (!body.sessionID) throw new SpecError("Missing sessionID.")
            return Response.json({ text: await d.schedules.call(req.params.op ?? "", body.sessionID, body) })
          }),
        },
      },
      fetch: () => Response.json({ error: "Not found" }, { status: 404 }),
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  attach(deps: InternalDeps): void {
    this.deps = deps
  }

  stop(): void {
    this.server.stop(true)
  }

  /** What every process the agent runs gets on top of the bot's environment. */
  env(gitConfig: string, base: Record<string, string | undefined> = process.env): Record<string, string> {
    const n = Number(base.GIT_CONFIG_COUNT) || 0
    return {
      BOT_INTERNAL_URL: this.url,
      BOT_INTERNAL_TOKEN: this.token,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      // A config include rather than the settings themselves, so connecting the GitHub App needs no restart.
      GIT_CONFIG_COUNT: String(n + 1),
      [`GIT_CONFIG_KEY_${n}`]: "include.path",
      [`GIT_CONFIG_VALUE_${n}`]: gitConfig,
    }
  }

  private authorised(req: Request): boolean {
    const header = req.headers.get("authorization") ?? ""
    const a = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "")
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }
}
