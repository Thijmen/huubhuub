import type { Bridge, Host } from "../opencode"
import type { Store } from "../store"

type Session = Awaited<ReturnType<Host["session"]["list"]>>["data"][number]
type Message = Awaited<ReturnType<Host["message"]["list"]>>["data"][number]

const HOUR = 3_600_000
const PAGE = 200
const CONCURRENCY = 6
/** A report this fresh is served as is; the page polls, and a full scan isn't free. */
const FRESH_MS = 20_000

export type UsageSource = "conversation" | "schedule" | "memory" | "other"

export interface UsageSession {
  id: string
  title: string | null
  source: UsageSource
  /** Who the conversation is with, for conversations and their subagents. */
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

type Bucket = { hour: number; model: string; cost: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; turns: number }

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

/** Spend across every OpenCode session, from the cost OpenCode records on each assistant turn. */
export class Usage {
  private cache = new Map<string, { updated: number; buckets: Bucket[] }>()
  private last?: UsageReport
  private pending?: Promise<UsageReport>

  constructor(
    private readonly bridge: Bridge,
    private readonly store: Store,
  ) {}

  report(): Promise<UsageReport> {
    if (this.last && Date.now() - this.last.generatedAt < FRESH_MS) return Promise.resolve(this.last)
    this.pending ??= this.build().finally(() => (this.pending = undefined))
    return this.pending
  }

  private async build(): Promise<UsageReport> {
    const sessions = await this.sessions()
    // Only sessions that changed since the last scan are read again.
    await pool(sessions, CONCURRENCY, async (s) => {
      const hit = this.cache.get(s.id)
      if (hit && hit.updated === s.time.updated) return
      const buckets = bucketMessages(await this.messages(s.id))
      this.cache.set(s.id, { updated: s.time.updated, buckets })
    })
    const ids = new Set(sessions.map((s) => s.id))
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id)

    const byId = new Map(sessions.map((s) => [s.id, s]))
    const models: string[] = []
    const modelIndex = new Map<string, number>()
    const rows: UsageRow[] = []
    const out: UsageSession[] = []
    for (const s of sessions) {
      const buckets = this.cache.get(s.id)?.buckets ?? []
      if (!buckets.length) continue
      const index = out.length
      out.push(this.describe(s, byId))
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
    this.last = { generatedAt: Date.now(), sessions: out, models, people, rows }
    return this.last
  }

  /** Where a session's spend comes from. Subagent sessions count towards the session that started them. */
  private describe(s: Session, byId: Map<string, Session>): UsageSession {
    let root = s
    for (let i = 0; root.parentID && byId.has(root.parentID) && i < 20; i++) root = byId.get(root.parentID)!
    const thread = this.store.bySession(root.id)
    const run = thread ? undefined : this.store.runBySession(root.id)
    const source: UsageSource = thread ? "conversation" : run ? "schedule" : root.metadata?.purpose === "memory-review" ? "memory" : "other"
    return {
      id: s.id,
      title: s.title ?? null,
      source,
      userId: thread ? (thread.userId ?? (thread.chatId > 0 ? thread.chatId : null)) : null,
      schedule: run ? (this.store.schedule(run.scheduleId)?.name ?? "Deleted schedule") : null,
      open: thread || run ? root.id : null,
      parentID: s.parentID ?? null,
      cost: s.cost,
      created: s.time.created,
      updated: s.time.updated,
    }
  }

  private async sessions(): Promise<Session[]> {
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
