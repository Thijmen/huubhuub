import type { Host } from "../opencode"
import { plainText, toAppMessages } from "./events"

type Message = Awaited<ReturnType<Host["message"]["list"]>>["data"][number]
type ListMessages = (sessionID: string, cursor?: string) => Promise<{ data: Message[]; cursor: { next?: string | null } }>

const PAGE = 200
/** How far back a conversation is searched. */
const MAX_MESSAGES = 1000
const SNIPPET_CHARS = 60
const MAX_CACHED = 300

export interface Searchable {
  sessionID: string
  title: string | null
  /** When the session last changed; the cached text is reused until then. */
  updated: number
}

export interface Hit {
  sessionID: string
  /** Null when only the title matched. */
  snippet: string | null
  messageId: string | null
}

interface Entry {
  updated: number
  texts: { id: string; text: string }[]
}

/** Search a person's conversations by title and by what was said, newest conversations first. */
export class ConversationSearch {
  private cache = new Map<string, Entry>()

  constructor(private readonly list: ListMessages) {}

  async search(query: string, conversations: Searchable[], limit = 30): Promise<Hit[]> {
    const needle = fold(query.trim())
    if (needle.length < 2) return []
    const hits: Hit[] = []
    for (const c of conversations) {
      if (hits.length >= limit) break
      const titleHit = c.title !== null && fold(c.title).includes(needle)
      const texts = await this.texts(c).catch(() => [])
      // Newest message first: that's usually the one you're looking for.
      const match = [...texts].reverse().find((t) => fold(t.text).includes(needle))
      if (match) hits.push({ sessionID: c.sessionID, snippet: snippet(match.text, needle), messageId: match.id })
      else if (titleHit) hits.push({ sessionID: c.sessionID, snippet: null, messageId: null })
    }
    return hits
  }

  private async texts(c: Searchable): Promise<Entry["texts"]> {
    const cached = this.cache.get(c.sessionID)
    if (cached && cached.updated >= c.updated) return cached.texts
    const messages: Message[] = []
    let cursor: string | undefined
    while (messages.length < MAX_MESSAGES) {
      const page = await this.list(c.sessionID, cursor)
      messages.push(...page.data)
      cursor = page.cursor.next ?? undefined
      if (!cursor || page.data.length < PAGE) break
    }
    const texts = toAppMessages(messages.reverse()).map((m) => ({ id: m.id, text: plainText(m.role === "user" ? m.text : m.parts.join(" ")) }))
    if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(c.sessionID, { updated: c.updated, texts })
    return texts
  }
}

/** Lowercase without accents, so "cafe" finds "Café". Keeps the length, so positions line up with the original. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
}

/** The text around the first match, trimmed at word boundaries. */
export function snippet(text: string, needle: string): string {
  const folded = fold(text)
  const at = folded.indexOf(needle)
  // Folding can drop combining marks, which shifts positions in rare cases; close enough for a snippet.
  const start = Math.max(0, at - SNIPPET_CHARS)
  const end = Math.min(text.length, at + needle.length + SNIPPET_CHARS)
  let out = text.slice(start, end)
  if (start > 0) out = `…${out.replace(/^\S*\s/, "")}`
  if (end < text.length) out = `${out.replace(/\s\S*$/, "")}…`
  return out
}
