import { OpenCode, type OpenCodeEvent } from "@opencode/sdk"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseModelRef, type Config } from "./config"
import type { Store } from "./store"

export type Host = Awaited<ReturnType<typeof OpenCode.create>>
export type SessionEvent = Extract<OpenCodeEvent, { data: { sessionID: string } }>
type Listener = (event: SessionEvent) => void
type ModelRef = { providerID: string; id: string }

export interface Attachment {
  uri: string
  name?: string
  description?: string
}

export class Bridge {
  private listeners = new Map<string, Set<Listener>>()
  private abort = new AbortController()
  private constructor(
    readonly host: Host,
    private readonly config: Config,
    private readonly store: Store,
  ) {}

  static async start(config: Config, store: Store): Promise<Bridge> {
    const configFile = process.env.OPENCODE_BOT_CONFIG ?? join(import.meta.dir, "..", "opencode.jsonc")
    const host = await OpenCode.create({
      app: { name: "telegram-bot" },
      database: { path: join(config.DATA_DIR, "opencode.sqlite") },
      config: existsSync(configFile) ? { content: readFileSync(configFile, "utf8") } : undefined,
      log: {
        level: config.OPENCODE_LOG_LEVEL,
        emit: (e) => console.error(`[opencode:${e.level}] ${e.message}`, e.attributes ?? "", e.cause ?? ""),
      },
    })
    const bridge = new Bridge(host, config, store)
    await bridge.warmup()
    await bridge.checkDefaultModel()
    void bridge.pump()
    return bridge
  }

  private async checkDefaultModel(): Promise<void> {
    const models = await this.models()
    console.log(`OpenCode ready: ${models.length} models available`)
    if (models.length === 0) console.warn("No models available. Set a provider API key (e.g. ANTHROPIC_API_KEY).")
    if (!this.config.DEFAULT_MODEL) return
    const ref = parseModelRef(this.config.DEFAULT_MODEL)
    if (!models.some((m) => m.providerID === ref.providerID && m.id === ref.id)) {
      console.warn(`DEFAULT_MODEL ${this.config.DEFAULT_MODEL} is not available; falling back to OpenCode's default.`)
      this.config.DEFAULT_MODEL = undefined
    }
  }

  private get location() {
    return { location: { directory: this.config.WORKSPACE_DIR } }
  }

  /** The Location loads plugins lazily; wait until built-in agents are registered. */
  private async warmup(): Promise<void> {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const agents = await this.host.agent.list(this.location).catch(() => undefined)
      if (agents && agents.data.length > 0) return
      await Bun.sleep(500)
    }
    throw new Error("OpenCode did not become ready within 60s")
  }

  private async pump(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        for await (const event of this.host.events.subscribe({ signal: this.abort.signal })) {
          const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID
          if (typeof sessionID !== "string") continue
          for (const fn of this.listeners.get(sessionID) ?? []) {
            try {
              fn(event as SessionEvent)
            } catch (err) {
              console.error("listener failed", err)
            }
          }
        }
      } catch (err) {
        if (this.abort.signal.aborted) return
        console.error("event stream failed, resubscribing", err)
      }
      await Bun.sleep(1000)
    }
  }

  subscribe(sessionID: string, fn: Listener): () => void {
    let set = this.listeners.get(sessionID)
    if (!set) this.listeners.set(sessionID, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0) this.listeners.delete(sessionID)
    }
  }

  async createSession(chatId: number, carry?: { model?: ModelRef; agent?: string }): Promise<string> {
    const model = carry?.model ?? (this.config.DEFAULT_MODEL ? parseModelRef(this.config.DEFAULT_MODEL) : undefined)
    const session = await this.host.sessions.create({
      ...this.location,
      title: `Telegram chat ${chatId}`,
      metadata: { telegramChatId: chatId },
      ...(model ? { model } : {}),
      ...((carry?.agent ?? this.config.DEFAULT_AGENT) ? { agent: carry?.agent ?? this.config.DEFAULT_AGENT } : {}),
    })
    this.store.set(chatId, session.id)
    return session.id
  }

  async sessionFor(chatId: number): Promise<string> {
    const existing = this.store.get(chatId)
    if (existing) {
      const ok = await this.host.sessions.get({ sessionID: existing.sessionID }).then(
        () => true,
        () => false,
      )
      if (ok) return existing.sessionID
    }
    return this.createSession(chatId)
  }

  /** Start a fresh session, keeping the previous model and agent selection. */
  async resetSession(chatId: number): Promise<string> {
    const prev = this.store.get(chatId)
    const info = prev ? await this.host.sessions.get({ sessionID: prev.sessionID }).catch(() => undefined) : undefined
    return this.createSession(chatId, {
      model: info?.model ? { providerID: info.model.providerID, id: info.model.id } : undefined,
      agent: info?.agent,
    })
  }

  prompt(sessionID: string, text: string, files: Attachment[] = []) {
    return this.host.sessions.prompt({ sessionID, text, files, delivery: "queue" })
  }

  interrupt(sessionID: string) {
    return this.host.sessions.interrupt({ sessionID })
  }

  getSession(sessionID: string) {
    return this.host.sessions.get({ sessionID })
  }

  async models() {
    const res = await this.host.model.list(this.location)
    return res.data.filter((m) => m.enabled && m.status !== "deprecated")
  }

  async agents() {
    const res = await this.host.agent.list(this.location)
    return res.data.filter((a) => !a.hidden && a.mode !== "subagent")
  }

  switchModel(sessionID: string, model: ModelRef) {
    return this.host.sessions.switchModel({ sessionID, model })
  }

  switchAgent(sessionID: string, agent: string) {
    return this.host.sessions.switchAgent({ sessionID, agent })
  }

  async close(): Promise<void> {
    this.abort.abort()
    await this.host.close()
  }
}
