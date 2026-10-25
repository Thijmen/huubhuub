import { InlineKeyboard, type Api } from "grammy"
import { truncate } from "./format"
import { parseModelRef } from "./config"
import type { Bridge, SessionEvent } from "./opencode"
import { displayName, MemoryError, type Personas } from "./personas"
import { threadParams } from "./reply"
import { isAppChat, type Memory, type Store } from "./store"

const DEBOUNCE_MS = 1500
const MAX_MESSAGES = 12
const MAX_TEXT = 2000
const MAX_ADDS = 3
/** Review session key when the conversation uses OpenCode's default model. */
const DEFAULT = "default"

type Message = Awaited<ReturnType<Bridge["host"]["message"]["list"]>>["data"][number]

export interface ReviewResult {
  add: string[]
  update: { id: number; text: string }[]
}

/**
 * Automatic memory: after each finished turn in a Telegram conversation with a user in `auto` mode, ask a
 * model, in a separate call, whether the user said anything worth remembering. Saves are posted in the
 * thread with a Forget button, so nothing is remembered silently.
 *
 * The call goes through `session.generate` in an empty session the bot keeps per model, which stays out of
 * the conversation's history and sends only the review prompt: no conversation, tools or agent prompt.
 * OpenCode's free models refuse calls made outside a session, which rules out `generate.text`.
 */
export class MemoryReview {
  /** The newest message already reviewed, per session. */
  private reviewed = new Map<string, string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private running = new Map<string, Promise<void>>()
  /** The empty session used for reviews with MEMORY_MODEL, per model. */
  private reviewSessions = new Map<string, Promise<string>>()
  private off?: () => void

  constructor(
    private readonly d: {
      bridge: Pick<Bridge, "subscribeAll" | "location" | "selection"> & { host: Pick<Bridge["host"], "message" | "session"> }
      store: Store
      personas: Personas
      api: Pick<Api, "sendMessage">
      /** `provider/model`, or undefined to use the conversation's model. */
      memoryModel: () => string | undefined
    },
  ) {}

  start(): void {
    this.off = this.d.bridge.subscribeAll((e: SessionEvent) => {
      if (e.type !== "session.execution.succeeded") return
      const sessionID = (e.data as { sessionID: string }).sessionID
      if (!this.applies(sessionID)) return
      clearTimeout(this.timers.get(sessionID))
      this.timers.set(
        sessionID,
        setTimeout(() => {
          this.timers.delete(sessionID)
          void this.review(sessionID)
        }, DEBOUNCE_MS),
      )
    })
  }

  stop(): void {
    this.off?.()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** Telegram conversations (not scheduled runs) with a known user whose memory is automatic. */
  private applies(sessionID: string): boolean {
    if (!this.d.store.bySession(sessionID) || this.d.store.runBySession(sessionID)) return false
    const userId = this.d.personas.userOf(sessionID)
    return userId !== null && this.d.personas.memoryMode(userId) === "auto"
  }

  /** Review the turns since the last review. Runs one at a time per session. */
  review(sessionID: string): Promise<void> {
    const previous = this.running.get(sessionID) ?? Promise.resolve()
    const next = previous
      .then(() => this.run(sessionID))
      .catch((err) => console.error(`Memory review failed for ${sessionID}`, err))
      .finally(() => {
        if (this.running.get(sessionID) === next) this.running.delete(sessionID)
      })
    this.running.set(sessionID, next)
    return next
  }

  private async run(sessionID: string): Promise<void> {
    if (!this.applies(sessionID)) return
    const userId = this.d.personas.userOf(sessionID)!
    const page = await this.d.bridge.host.message.list({ sessionID, order: "desc", limit: 40 })
    const newest = page.data[0]?.id
    const turn = latestTurns(page.data, this.reviewed.get(sessionID))
    if (newest) this.reviewed.set(sessionID, newest)
    if (!turn.some((m) => m.role === "user")) return

    const name = displayName(this.d.store.person(userId))
    const existing = this.d.store.memories(userId)
    const text = await this.generate(sessionID, reviewPrompt(name, existing, turn))
    await this.apply(sessionID, userId, existing, parseReview(text))
  }

  /** Ask in an empty review session for the model: MEMORY_MODEL, else the conversation's. */
  private async generate(conversation: string, prompt: string): Promise<string> {
    const { session } = this.d.bridge.host
    const model = this.d.memoryModel() ?? (await this.d.bridge.selection(conversation).catch(() => ({ model: null }))).model ?? DEFAULT
    const reviewSession = await this.reviewSession(model)
    try {
      return (await session.generate({ sessionID: reviewSession, prompt })).text
    } catch (err) {
      // Someone may have deleted the review session; make a new one once.
      if (await session.get({ sessionID: reviewSession }).then(() => true, () => false)) throw err
      this.reviewSessions.delete(model)
      this.d.store.setSetting(reviewSessionKey(model), undefined)
      return (await session.generate({ sessionID: await this.reviewSession(model), prompt })).text
    }
  }

  private reviewSession(model: string): Promise<string> {
    let pending = this.reviewSessions.get(model)
    if (!pending) {
      pending = this.findOrCreateReviewSession(model)
      pending.catch(() => this.reviewSessions.delete(model))
      this.reviewSessions.set(model, pending)
    }
    return pending
  }

  private async findOrCreateReviewSession(model: string): Promise<string> {
    const { session } = this.d.bridge.host
    const stored = this.d.store.getSetting(reviewSessionKey(model))
    if (stored && (await session.get({ sessionID: stored }).then(() => true, () => false))) return stored
    const created = await session.create({
      ...this.d.bridge.location,
      title: `Memory review (${model === DEFAULT ? "default model" : model})`,
      metadata: { purpose: "memory-review" },
      ...(model === DEFAULT ? {} : { model: parseModelRef(model) }),
      // Reviews only produce text; the session never needs a tool.
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    })
    this.d.store.setSetting(reviewSessionKey(model), created.id)
    return created.id
  }

  private async apply(sessionID: string, userId: number, existing: Memory[], result: ReviewResult): Promise<void> {
    const saved: { memory: Memory; verb: string }[] = []
    for (const u of result.update) {
      const current = existing.find((m) => m.id === u.id)
      if (!current || current.text === u.text.trim()) continue
      try {
        const updated = this.d.store.updateMemory(current.id, cleanText(u.text))
        if (updated) saved.push({ memory: updated, verb: "Updated" })
      } catch (err) {
        if (!(err instanceof MemoryError)) throw err
      }
    }
    for (const text of result.add.slice(0, MAX_ADDS)) {
      try {
        const before = this.d.store.memories(userId).length
        const memory = this.d.personas.add(userId, text, "agent")
        if (this.d.store.memories(userId).length > before) saved.push({ memory, verb: "Remembered" })
      } catch (err) {
        if (!(err instanceof MemoryError)) throw err
      }
    }
    const key = this.d.store.bySession(sessionID)
    // App-only chats have no place for these notes yet; the app's memory screen shows what was saved.
    if (!key || isAppChat(key.chatId)) return
    for (const { memory, verb } of saved) {
      await this.d.api
        .sendMessage(key.chatId, `🧠 <i>${verb}:</i> ${escape(truncate(memory.text, 400))}`, {
          parse_mode: "HTML",
          disable_notification: true,
          reply_markup: new InlineKeyboard().text("Forget", `mx:${memory.id}`),
          ...threadParams(key),
        })
        .catch((err) => console.error("Couldn't post a memory notice", err))
    }
  }
}

function reviewSessionKey(model: string): string {
  return `memory_review_session:${model}`
}

function cleanText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (!clean || clean.length > 500) throw new MemoryError("Bad memory text.")
  return clean
}

/** The user and assistant text since `after` (exclusive), oldest first. Without `after`, only the latest turn. */
export function latestTurns(newestFirst: Message[], after?: string): { role: "user" | "assistant"; text: string }[] {
  const out: { role: "user" | "assistant"; text: string }[] = []
  let idles = 0
  for (const m of newestFirst) {
    if (m.id === after) break
    if (m.type === "idle") {
      if (!after && ++idles === 2) break
      continue
    }
    if (m.type === "user" && m.text.trim()) out.push({ role: "user", text: truncate(m.text.trim(), MAX_TEXT) })
    if (m.type === "assistant") {
      const text = m.content
        .flatMap((c) => (c.type === "text" ? [c.text] : []))
        .join("\n")
        .trim()
      if (text) out.push({ role: "assistant", text: truncate(text, MAX_TEXT) })
    }
    if (out.length >= MAX_MESSAGES) break
  }
  return out.reverse()
}

export function reviewPrompt(name: string, existing: Memory[], turn: { role: "user" | "assistant"; text: string }[]): string {
  const known = existing.length ? existing.map((m) => `#${m.id}: ${m.text}`).join("\n") : "(nothing yet)"
  const chat = turn.map((m) => `${m.role === "user" ? name : "Assistant"}: ${m.text}`).join("\n\n")
  return `You keep the long-term memory of a personal assistant about one user, ${name}. Read the latest exchange and decide whether ${name} shared personal information worth remembering in future conversations.

Remember personal facts ${name} states about themselves, even in passing. For example:
- people in their life: partner, children, family, friends, colleagues, and their names
- pets
- where they live, their work, their job title or company
- interests and hobbies, sports they play or follow, favourite teams, music, food
- diet, preferences and dislikes, how they like the assistant to help them
- their tech stack, ongoing projects, important decisions, recurring commitments

Don't remember:
- questions they ask, or things only relevant to the current task
- reactions to the assistant's reply, greetings, passing moods
- anything the assistant said rather than ${name}
- passwords, tokens, or health or financial details
- facts already in memory; if one is now outdated or more specific, update it instead

Already remembered:
${known}

Latest exchange:
${chat}

Reply with JSON only, no other text: {"add": ["..."], "update": [{"id": 1, "text": "..."}]}
Each memory is one short sentence in English about ${name} in the third person without their name, e.g. "Is a fan of FC Twente." Use empty lists when there's nothing to remember, which is often the case.`
}

/** The model's JSON reply, tolerating code fences and stray text. Anything unreadable means nothing to save. */
export function parseReview(text: string): ReviewResult {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return { add: [], update: [] }
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as { add?: unknown; update?: unknown }
    const add = Array.isArray(raw.add) ? raw.add.filter((a): a is string => typeof a === "string" && a.trim().length > 0) : []
    const update = Array.isArray(raw.update)
      ? raw.update.flatMap((u) => {
          const { id, text } = (u ?? {}) as { id?: unknown; text?: unknown }
          return Number.isInteger(Number(id)) && typeof text === "string" && text.trim() ? [{ id: Number(id), text }] : []
        })
      : []
    return { add, update }
  } catch {
    return { add: [], update: [] }
  }
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
