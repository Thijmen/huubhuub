import type { Bridge, Host } from "./opencode"
import type { Store } from "./store"

type Session = Awaited<ReturnType<Host["session"]["list"]>>["data"][number]
type Message = Awaited<ReturnType<Host["message"]["list"]>>["data"][number]

const HOUR = 3_600_000
const PAGE = 200
const CONCURRENCY = 6
/** A scan this fresh is reused; the admin page polls, and a full scan isn't free. */
const FRESH_MS = 20_000
/** Limit checks rely on live model calls between scans, and rescan at most this often. */
const BACKGROUND_MS = 5 * 60_000
const MAX_DEPTH = 20

export type UsageSource = "conversation" | "schedule" | "memory" | "other"

export interface UsageSession {
  id: string
  title: string | null
  source: UsageSource
  /** Who the spend counts towards: the person in the conversation, or whose private chat a scheduled task posts in. */
  userId: number | null
  /** The schedule's name, for scheduled runs. */
  schedule: string | null
  /** The session to open in the Conversations tab: the session itself, or the conversation a subagent ran in. */
  open: string | null
  parentID: string | null
  cost: number
  created: number
  updated: number
}

/** `[hourStart, session index, model index, cost, input, output, reasoning, cacheRead, cacheWrite, turns]` */
export type UsageRow = [number, number, number, number, number, number, number, number, number, number]

export interface UsageReport {
  generatedAt: number
  sessions: UsageSession[]
  models: string[]
  people: { id: number; name: string }[]
  rows: UsageRow[]
}

/** Who a session's spend belongs to. Subagent sessions belong to the session that started them. */
export interface Owner {
  root: string
  source: UsageSource
  userId: number | null
  schedule: string | null
  /** Whether the root session lives in a Telegram thread (and so can be opened in the admin UI). */
  bound: boolean
}

export interface SessionTotals {
  cost: number
  turns: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  /** Spend per model, highest first. */
  models: { model: string; cost: number }[]
  /** Subagent sessions included in the totals. */
  subagents: number
}

export type Bucket = { hour: number; model: string; cost: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; turns: number }

/** Sum assistant turns into one bucket per hour and model. */
export function bucketMessages(messages: Message[]): Bucket[] {
  const out = new Map<string, Bucket>()
  for (const m of messages) {
    if (m.type !== "assistant" || (!m.cost && !m.tokens)) continue
    const hour = Math.floor(m.time.created / HOUR) * HOUR
    const model = `${m.model.providerID}/${m.model.id}`
    const key = `${hour}|${model}`
    const b = out.get(key) ?? { hour, model, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }
    b.cost += m.cost ?? 0
    b.input += m.tokens?.input ?? 0
    b.output += m.tokens?.output ?? 0
    b.reasoning += m.tokens?.reasoning ?? 0
    b.cacheRead += m.tokens?.cache.read ?? 0
    b.cacheWrite += m.tokens?.cache.write ?? 0
    b.turns++
    out.set(key, b)
  }
  return [...out.values()]
}

/**
 * Spend across every OpenCode session, from the cost OpenCode records on each assistant turn. Sessions are
 * re-read when they change; model calls that finish in between are counted live from session events.
 */
export class Usage {
  private sessions = new Map<string, Session>()
  private scans = new Map<string, { updated: number; at: number; buckets: Bucket[] }>()
  /** Model calls that finished after their session was last read. */
  private live: { sessionID: string; at: number; cost: number }[] = []
  private syncedAt = 0
  private pending?: Promise<void>

  constructor(
    private readonly bridge: Pick<Bridge, "host">,
    private readonly store: Pick<Store, "bySession" | "runBySession" | "schedule" | "people" | "ownerOfChat">,
  ) {}

  /** Re-read sessions that changed, unless the last scan is younger than `maxAge`. */
  sync(maxAge = FRESH_MS): Promise<void> {
    if (this.syncedAt && Date.now() - this.syncedAt < maxAge) return Promise.resolve()
    this.pending ??= this.scan().finally(() => (this.pending = undefined))
    return this.pending
  }

  /** Waits for the first scan only; later scans run in the background, and live model calls cover the gap. */
  async ready(): Promise<void> {
    if (!this.syncedAt) return this.sync()
    void this.sync(BACKGROUND_MS).catch((err) => console.error("usage scan failed", err))
  }

  /** Count a model call as soon as it finishes. */
  async observe(sessionID: string, at: number, cost: number): Promise<void> {
    if (cost > 0) this.live.push({ sessionID, at, cost })
    await this.learn(sessionID)
  }

  owner(sessionID: string): Owner | null {
    let s = this.sessions.get(sessionID)
    if (!s) return null
    for (let i = 0; s.parentID && this.sessions.has(s.parentID) && i < MAX_DEPTH; i++) s = this.sessions.get(s.parentID)!
    const thread = this.store.bySession(s.id)
    const run = this.store.runBySession(s.id)
    const schedule = run ? this.store.schedule(run.scheduleId) : undefined
    const chatId = thread?.chatId ?? schedule?.chatId ?? null
    return {
      root: s.id,
      source: run ? "schedule" : thread ? "conversation" : s.metadata?.purpose === "memory-review" ? "memory" : "other",
      userId: thread?.userId ?? (chatId !== null ? this.store.ownerOfChat(chatId) : null),
      schedule: run ? (schedule?.name ?? "Deleted schedule") : null,
      bound: Boolean(thread),
    }
  }

  /** What a person has spent since `from`. */
  spentBy(userId: number, from: number): number {
    const hour = Math.floor(from / HOUR) * HOUR
    const owners = new Map<string, number | null>()
    const ownerOf = (id: string) => {
      if (!owners.has(id)) owners.set(id, this.owner(id)?.userId ?? null)
      return owners.get(id)
    }
    let total = 0
    for (const [id, scan] of this.scans) {
      let sum = 0
      for (const b of scan.buckets) if (b.hour >= hour) sum += b.cost
      if (sum && ownerOf(id) === userId) total += sum
    }
    for (const e of this.live) if (e.at >= from && ownerOf(e.sessionID) === userId) total += e.cost
    return total
  }

  /** A session's spend, including the subagents it started. */
  totals(sessionID: string): SessionTotals {
    const ids = new Set([sessionID])
    for (let grew = true; grew; ) {
      grew = false
      for (const s of this.sessions.values()) {
        if (s.parentID && ids.has(s.parentID) && !ids.has(s.id)) {
          ids.add(s.id)
          grew = true
        }
      }
    }
    const out: SessionTotals = { cost: 0, turns: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, models: [], subagents: ids.size - 1 }
    const models = new Map<string, number>()
    for (const id of ids) {
      for (const b of this.scans.get(id)?.buckets ?? []) {
        out.cost += b.cost
        out.turns += b.turns
        out.tokens.input += b.input
        out.tokens.output += b.output
        out.tokens.reasoning += b.reasoning
        out.tokens.cacheRead += b.cacheRead
        out.tokens.cacheWrite += b.cacheWrite
        models.set(b.model, (models.get(b.model) ?? 0) + b.cost)
      }
    }
    for (const e of this.live) {
      if (!ids.has(e.sessionID)) continue
      out.cost += e.cost
      out.turns++
    }
    out.models = [...models.entries()].map(([model, cost]) => ({ model, cost })).sort((a, b) => b.cost - a.cost)
    return out
  }

  async report(): Promise<UsageReport> {
    await this.sync()
    const models: string[] = []
    const modelIndex = new Map<string, number>()
    const rows: UsageRow[] = []
    const out: UsageSession[] = []
    for (const s of this.sessions.values()) {
      const buckets = this.scans.get(s.id)?.buckets ?? []
      if (!buckets.length) continue
      const index = out.length
      const owner = this.owner(s.id)!
      out.push({
        id: s.id,
        title: s.title ?? null,
        source: owner.source,
        userId: owner.userId,
        schedule: owner.schedule,
        open: owner.bound || owner.source === "schedule" ? owner.root : null,
        parentID: s.parentID ?? null,
        cost: s.cost,
        created: s.time.created,
        updated: s.time.updated,
      })
      for (const b of buckets) {
        let m = modelIndex.get(b.model)
        if (m === undefined) {
          m = models.push(b.model) - 1
          modelIndex.set(b.model, m)
        }
        rows.push([b.hour, index, m, b.cost, b.input, b.output, b.reasoning, b.cacheRead, b.cacheWrite, b.turns])
      }
    }
    rows.sort((a, b) => a[0] - b[0])
    const people = this.store.people().map((p) => ({ id: p.id, name: p.name ?? (p.username ? `@${p.username}` : String(p.id)) }))
    return { generatedAt: this.syncedAt, sessions: out, models, people, rows }
  }

  private async scan(): Promise<void> {
    const started = Date.now()
    const list = await this.list()
    const ids = new Set(list.map((s) => s.id))
    for (const s of list) this.sessions.set(s.id, s)
    await pool(list, CONCURRENCY, async (s) => {
      const hit = this.scans.get(s.id)
      if (hit && hit.updated === s.time.updated) return
      const at = Date.now()
      const buckets = bucketMessages(await this.messages(s.id))
      this.scans.set(s.id, { updated: s.time.updated, at, buckets })
      // The scan now includes these calls.
      this.live = this.live.filter((e) => e.sessionID !== s.id || e.at > at)
    })
    for (const id of this.scans.keys()) if (!ids.has(id)) this.scans.delete(id)
    for (const id of this.sessions.keys()) if (!ids.has(id) && !this.live.some((e) => e.sessionID === id)) this.sessions.delete(id)
    this.syncedAt = started
  }

  /** Make sure a session and its parents are known, so its spend can be attributed. */
  private async learn(sessionID: string): Promise<void> {
    let next: string | undefined = sessionID
    for (let i = 0; next && i < MAX_DEPTH; i++) {
      let s = this.sessions.get(next)
      if (!s) {
        s = await this.bridge.host.session.get({ sessionID: next }).catch(() => undefined)
        if (!s) return
        this.sessions.set(next, s)
      }
      next = s.parentID
    }
  }

  private async list(): Promise<Session[]> {
    const out: Session[] = []
    let cursor: string | undefined
    while (true) {
      const page = await this.bridge.host.session.list({ limit: PAGE, order: "desc", ...(cursor ? { cursor } : {}) })
      out.push(...page.data)
      cursor = page.cursor.next ?? undefined
      if (!cursor || page.data.length < PAGE) return out
    }
  }

  private async messages(sessionID: string): Promise<Message[]> {
    const out: Message[] = []
    let cursor: string | undefined
    while (true) {
      const page = await this.bridge.host.message.list({ sessionID, type: "assistant", order: "desc", limit: PAGE, ...(cursor ? { cursor } : {}) })
      out.push(...page.data)
      cursor = page.cursor.next ?? undefined
      if (!cursor || page.data.length < PAGE) return out
    }
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item).catch((err) => console.error("usage scan failed", err))
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}
