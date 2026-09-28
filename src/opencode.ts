import { OpenCode, type OpenCodeEvent } from "@opencode/sdk"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseModelRef, type Config } from "./config"
import type { ChatKey, Store } from "./store"

export type Host = Awaited<ReturnType<typeof OpenCode.create>>
export type SessionEvent =
  | Extract<OpenCodeEvent, { data: { sessionID: string } }>
  | Extract<OpenCodeEvent, { type: "form.created" }>
export type McpConfig = Parameters<Host["mcp"]["add"]>[0]["config"]
type Listener = (event: SessionEvent) => void
type ModelRef = { providerID: string; id: string }
type Carry = { model?: ModelRef; agent?: string }

export interface Attachment {
  uri: string
  name?: string
  description?: string
}

export class Bridge {
  private listeners = new Map<string, Set<Listener>>()
  private global = new Set<Listener>()
  private abort = new AbortController()
  private constructor(
    readonly host: Host,
    readonly config: Config,
    private readonly store: Store,
  ) {}

  static async start(config: Config, store: Store): Promise<Bridge> {
    const host = await OpenCode.create({
      app: { name: "telegram-bot" },
      database: { path: join(config.DATA_DIR, "opencode.sqlite") },
      config: existsSync(configFile()) ? { content: readFileSync(configFile(), "utf8") } : undefined,
      log: {
        level: config.OPENCODE_LOG_LEVEL,
        emit: (e) => console.error(`[opencode:${e.level}] ${e.message}`, e.attributes ?? "", e.cause ?? ""),
      },
    })
    const bridge = new Bridge(host, config, store)
    await bridge.warmup()
    await bridge.applyMcpOverrides()
    await bridge.checkDefaultModel()
    void bridge.pump()
    return bridge
  }

  private async checkDefaultModel(): Promise<void> {
    const models = await this.models()
    console.log(`OpenCode ready: ${models.length} models available`)
    if (models.length === 0) console.warn("No models available. Connect a provider in the admin UI or set an API key.")
    if (!this.config.DEFAULT_MODEL) return
    const ref = parseModelRef(this.config.DEFAULT_MODEL)
    if (!models.some((m) => m.providerID === ref.providerID && m.id === ref.id)) {
      console.warn(`DEFAULT_MODEL ${this.config.DEFAULT_MODEL} is not available; falling back to OpenCode's default.`)
    }
  }

  get location() {
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

  /** MCP servers added or removed in the admin UI live in memory in OpenCode; replay them after every start. */
  private async applyMcpOverrides(): Promise<void> {
    for (const { name, config } of this.store.mcpServers()) {
      try {
        if (config === null) await this.host.mcp.remove({ ...this.location, server: name })
        else await this.host.mcp.add({ ...this.location, server: name, config: config as McpConfig })
      } catch (err) {
        console.error(`MCP server ${name} could not be restored`, err)
      }
    }
  }

  private async pump(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        for await (const event of this.host.events.subscribe({ signal: this.abort.signal })) {
          const sessionID = sessionOf(event)
          if (!sessionID) continue
          for (const fn of [...this.global, ...(this.listeners.get(sessionID) ?? [])]) {
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

  /** Every session event, before per-session listeners. */
  subscribeAll(fn: Listener): () => void {
    this.global.add(fn)
    return () => this.global.delete(fn)
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

  async createSession(key: ChatKey, carry: Carry = {}, autoTitle = false): Promise<string> {
    const model = carry.model ?? (this.config.DEFAULT_MODEL ? parseModelRef(this.config.DEFAULT_MODEL) : undefined)
    const agent = carry.agent ?? this.config.DEFAULT_AGENT
    // Leave the title unset so OpenCode generates one from the first prompt; bot-created topics are renamed to match.
    const session = await this.host.sessions.create({
      ...this.location,
      metadata: { telegramChatId: key.chatId, ...(key.threadId ? { telegramThreadId: key.threadId } : {}) },
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
    })
    this.store.set(key, session.id, autoTitle)
    return session.id
  }

  /** The session bound to a chat/thread. A new thread starts a new session with the chat's latest model and agent. */
  async sessionFor(key: ChatKey): Promise<string> {
    const existing = this.store.get(key)
    if (existing && (await this.exists(existing.sessionID))) return existing.sessionID
    const latest = this.store.latest(key.chatId)
    return this.createSession(key, latest ? await this.carryFrom(latest.sessionID) : {})
  }

  /** Start a fresh session in place, keeping the previous model and agent selection. */
  async resetSession(key: ChatKey): Promise<string> {
    const prev = this.store.get(key) ?? this.store.latest(key.chatId)
    return this.createSession(key, prev ? await this.carryFrom(prev.sessionID) : {})
  }

  /** Bind a topic the bot just created to a new session, inheriting model and agent from `from`. */
  async openThread(key: ChatKey, from: ChatKey): Promise<string> {
    const prev = this.store.get(from) ?? this.store.latest(from.chatId)
    return this.createSession(key, prev ? await this.carryFrom(prev.sessionID) : {}, true)
  }

  private async carryFrom(sessionID: string): Promise<Carry> {
    const info = await this.host.sessions.get({ sessionID }).catch(() => undefined)
    return {
      model: info?.model ? { providerID: info.model.providerID, id: info.model.id } : undefined,
      agent: info?.agent,
    }
  }

  private exists(sessionID: string): Promise<boolean> {
    return this.host.sessions.get({ sessionID }).then(
      () => true,
      () => false,
    )
  }

  prompt(sessionID: string, text: string, files: Attachment[] = []) {
    return this.host.sessions.prompt({ sessionID, text, files, delivery: "queue" })
  }

  replyForm(sessionID: string, formID: string, answer: Record<string, string | string[]>) {
    return this.host.sessions.form.reply({ sessionID, formID, answer })
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

/** Most events carry `data.sessionID`; `form.created` nests it in the form. */
function sessionOf(event: OpenCodeEvent): string | undefined {
  const data = (event as { data?: { sessionID?: unknown; form?: { sessionID?: unknown } } }).data
  const id = data?.sessionID ?? data?.form?.sessionID
  return typeof id === "string" ? id : undefined
}

export function configFile(): string {
  return process.env.OPENCODE_BOT_CONFIG ?? join(import.meta.dir, "..", "bot.opencode.jsonc")
}
