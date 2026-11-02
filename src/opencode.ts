import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseModelRef, type Config } from "./config"
import { stripJsonComments } from "./mcp-import"
import { OpenCodeServer } from "./opencode-server"
import { isAppChat, type ChatKey, type Store } from "./store"

export type Host = OpenCodeClient
export type SessionEvent =
  | Extract<OpenCodeEvent, { data: { sessionID: string } }>
  | Extract<OpenCodeEvent, { type: "form.created" }>
export type McpConfig = Parameters<Host["mcp"]["add"]>[0]["config"]
type Listener = (event: SessionEvent) => void
type Message = Awaited<ReturnType<Host["message"]["list"]>>["data"][number]
type ModelRef = { providerID: string; id: string }
type Carry = { model?: ModelRef; agent?: string }

/** One piece of an assistant reply as stored by OpenCode. */
export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown> | undefined; status: "running" | "ok" | "error" }

export interface Attachment {
  uri: string
  name?: string
  description?: string
}

export class Bridge {
  private listeners = new Map<string, Set<Listener>>()
  private global = new Set<Listener>()
  private resync = new Set<() => void>()
  private abort = new AbortController()
  private mcpRestore?: Promise<void>
  readonly host: Host
  private constructor(
    readonly server: OpenCodeServer,
    readonly config: Config,
    private readonly store: Store,
  ) {
    this.host = server.client
  }

  /**
   * `skillDirs` are added to the config's `skills` paths and `pluginDirs` to its `plugins`; OpenCode watches
   * them and reloads on change. `env` is added to the server's environment, which the agent's commands inherit.
   */
  static async start(
    config: Config,
    store: Store,
    opts: { skillDirs?: string[]; pluginDirs?: string[]; env?: () => Record<string, string> } = {},
  ): Promise<Bridge> {
    const server = new OpenCodeServer(config, serverPassword(config, store), configContent(opts.skillDirs ?? [], opts.pluginDirs ?? []), opts.env)
    const bridge = new Bridge(server, config, store)
    // MCP overrides live in the server's memory, so every (re)start replays them.
    server.onReady = async () => {
      await bridge.warmup()
      await bridge.applyMcpOverrides()
    }
    await server.start()
    await bridge.checkDefaultModel()
    void bridge.pump()
    return bridge
  }

  /** Restart OpenCode so it sees the current environment. Running turns resume after the restart. */
  restart(): Promise<void> {
    return this.server.restart()
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

  /**
   * OpenCode can rebuild a location without restarting (config reload, e.g. when a watched skill or plugin
   * directory changes), which drops MCP servers added at runtime. Replay them when that happens. With
   * `onlyIfMissing`, first check whether anything was actually lost (used after the event stream reconnects,
   * when a `location.shutdown` may have been missed).
   */
  private restoreMcpOverrides(onlyIfMissing = false): void {
    if (this.mcpRestore || this.server.status !== "running") return
    this.mcpRestore = (async () => {
      // Let the replacement location finish building before adding servers to it.
      await Bun.sleep(500)
      await this.warmup()
      if (onlyIfMissing && !(await this.mcpOverridesLost())) return
      console.log("OpenCode reloaded its location; restoring MCP servers from the admin UI")
      await this.applyMcpOverrides()
    })()
      .catch((err) => console.error("MCP servers could not be restored", err))
      .finally(() => (this.mcpRestore = undefined))
  }

  private async mcpOverridesLost(): Promise<boolean> {
    const present = new Set((await this.host.mcp.list(this.location)).data.map((s) => s.name))
    return this.store.mcpServers().some(({ name, config }) => (config === null) === present.has(name))
  }

  private async pump(): Promise<void> {
    let reconnect = false
    while (!this.abort.signal.aborted) {
      try {
        for await (const event of this.host.event.subscribe({ signal: this.abort.signal })) {
          // Events emitted while the stream was down are not replayed; let views catch up from storage.
          if (reconnect) {
            for (const fn of this.resync) fn()
            this.restoreMcpOverrides(true)
          }
          reconnect = false
          if (event.type === "location.shutdown") this.restoreMcpOverrides()
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
        // Expected while OpenCode restarts; only a drop on a running server is worth a stack trace.
        if (this.server.status === "running") console.error("event stream failed, resubscribing", err)
      }
      reconnect = true
      await Bun.sleep(1000)
    }
  }

  /** Every session event, before per-session listeners. */
  subscribeAll(fn: Listener): () => void {
    this.global.add(fn)
    return () => this.global.delete(fn)
  }

  /** Called after the event stream reconnects, when events may have been missed. */
  onResync(fn: () => void): () => void {
    this.resync.add(fn)
    return () => this.resync.delete(fn)
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
    const metadata: Record<string, number> = isAppChat(key.chatId)
      ? { appChatId: key.chatId, appThreadId: key.threadId }
      : { telegramChatId: key.chatId, ...(key.threadId ? { telegramThreadId: key.threadId } : {}) }
    const id = await this.createDetached(carry, metadata)
    this.store.set(key, id, autoTitle)
    return id
  }

  /** A session that isn't bound to a Telegram thread (yet), e.g. a scheduled run. */
  async createDetached(carry: Carry, metadata: Record<string, string | number>): Promise<string> {
    const model = carry.model ?? (this.config.DEFAULT_MODEL ? parseModelRef(this.config.DEFAULT_MODEL) : undefined)
    const agent = carry.agent ?? this.config.DEFAULT_AGENT
    // Leave the title unset so OpenCode generates one from the first prompt; bot-created topics are renamed to match.
    const session = await this.host.session.create({
      ...this.location,
      metadata,
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
    })
    return session.id
  }

  /** The model (as `provider/model`) and agent a session currently uses. */
  async selection(sessionID: string): Promise<{ model: string | null; agent: string | null }> {
    const carry = await this.carryFrom(sessionID)
    return { model: carry.model ? `${carry.model.providerID}/${carry.model.id}` : null, agent: carry.agent ?? null }
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
    const info = await this.host.session.get({ sessionID }).catch(() => undefined)
    return {
      model: info?.model ? { providerID: info.model.providerID, id: info.model.id } : undefined,
      agent: info?.agent,
    }
  }

  private exists(sessionID: string): Promise<boolean> {
    return this.host.session.get({ sessionID }).then(
      () => true,
      () => false,
    )
  }

  prompt(sessionID: string, text: string, files: Attachment[] = []) {
    return this.host.session.prompt({ sessionID, text, files, delivery: "queue" })
  }

  /** The assistant output since the latest user message, as stored by OpenCode. */
  async transcript(sessionID: string): Promise<TranscriptBlock[]> {
    const page = await this.host.message.list({ sessionID, order: "desc", limit: 50 })
    const since: Message[] = []
    for (const m of page.data) {
      if (m.type === "user") break
      since.push(m)
    }
    return since.reverse().flatMap(toBlocks)
  }

  /** Whether OpenCode is still executing the session. */
  async isActive(sessionID: string): Promise<boolean> {
    return sessionID in (await this.host.session.active())
  }

  replyForm(sessionID: string, formID: string, answer: Record<string, string | string[]>) {
    return this.host.session.form.reply({ sessionID, formID, answer })
  }

  interrupt(sessionID: string) {
    return this.host.session.interrupt({ sessionID })
  }

  getSession(sessionID: string) {
    return this.host.session.get({ sessionID })
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
    return this.host.session.switchModel({ sessionID, model })
  }

  switchAgent(sessionID: string, agent: string) {
    return this.host.session.switchAgent({ sessionID, agent })
  }

  async close(): Promise<void> {
    this.abort.abort()
    await this.server.stop()
  }
}

function toBlocks(m: Message): TranscriptBlock[] {
  if (m.type !== "assistant") return []
  return m.content.flatMap((c): TranscriptBlock[] => {
    if (c.type === "text") return [{ kind: "text", text: c.text }]
    if (c.type !== "tool") return []
    const status = c.state.status === "completed" ? "ok" : c.state.status === "error" ? "error" : "running"
    return [{ kind: "tool", id: c.id, name: c.name, input: c.state.input as Record<string, unknown> | undefined, status }]
  })
}

/** Most events carry `data.sessionID`; `form.created` nests it in the form. */
function sessionOf(event: OpenCodeEvent): string | undefined {
  const data = (event as { data?: { sessionID?: unknown; form?: { sessionID?: unknown } } }).data
  const id = data?.sessionID ?? data?.form?.sessionID
  return typeof id === "string" ? id : undefined
}

function configContent(skillDirs: string[], pluginDirs: string[]): string {
  const doc = existsSync(configFile())
    ? (JSON.parse(stripJsonComments(readFileSync(configFile(), "utf8"))) as { skills?: string[]; plugins?: unknown[] })
    : {}
  return JSON.stringify({ ...doc, skills: [...(doc.skills ?? []), ...skillDirs], plugins: [...(doc.plugins ?? []), ...pluginDirs] })
}

export function configFile(): string {
  return process.env.OPENCODE_BOT_CONFIG ?? join(import.meta.dir, "..", "bot.opencode.jsonc")
}

/** OPENCODE_SERVER_PASSWORD, or a generated one kept in SQLite so web UI sign-ins survive restarts. */
function serverPassword(config: Config, store: Store): string {
  if (config.OPENCODE_SERVER_PASSWORD) return config.OPENCODE_SERVER_PASSWORD
  let password = store.getSetting("opencode_password")
  if (!password) {
    password = randomBytes(24).toString("base64url")
    store.setSetting("opencode_password", password)
  }
  return password
}
