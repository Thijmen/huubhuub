import type { AppEvent, AppMessage, ConversationPage, Question, ToolKind } from "@server/protocol"

/** A message typed here that the server hasn't shown back yet. */
export interface Pending {
  id: string
  text: string
  /** Local files of photos sent along. */
  images: string[]
  createdAt: number
}

export interface ChatState {
  loaded: boolean
  title: string | null
  telegram: boolean
  messages: AppMessage[]
  pending: Pending[]
  older: string | null
  busy: boolean
  /** What Huub is doing right now, while a tool runs. */
  activity: { id: string; kind: ToolKind; detail: string } | null
  retry: { attempt: number; error: string } | null
  /** Why the last run failed, until the next one starts. */
  failure: string | null
  question: Question | null
}

export const initialChat: ChatState = {
  loaded: false,
  title: null,
  telegram: false,
  messages: [],
  pending: [],
  older: null,
  busy: false,
  activity: null,
  retry: null,
  failure: null,
  question: null,
}

export type ChatAction =
  | { type: "page"; page: ConversationPage; older?: boolean }
  | { type: "event"; event: AppEvent }
  | { type: "pending"; pending: Pending }
  | { type: "unsent"; id: string }
  | { type: "question"; question: Question | null }

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "page": {
      const { page } = a
      const messages = mergeMessages(s.messages, page.messages)
      if (a.older) return { ...s, messages, older: page.older }
      return {
        ...s,
        loaded: true,
        title: page.conversation.title ?? s.title,
        telegram: page.conversation.telegram,
        busy: page.conversation.busy,
        activity: page.conversation.busy ? s.activity : null,
        messages,
        older: s.loaded ? s.older : page.older,
        pending: s.pending.filter((p) => !delivered(p, page.messages)),
        question: openQuestion(page.question),
      }
    }
    case "pending":
      return { ...s, pending: [...s.pending, a.pending] }
    case "unsent":
      return { ...s, pending: s.pending.filter((p) => p.id !== a.id) }
    case "question":
      return { ...s, question: openQuestion(a.question) }
    case "event":
      return applyEvent(s, a.event)
  }
}

function applyEvent(s: ChatState, e: AppEvent): ChatState {
  switch (e.type) {
    case "run.started":
      return { ...s, busy: true, failure: null, retry: null }
    case "run.ended":
      return {
        ...s,
        busy: false,
        activity: null,
        retry: null,
        failure: e.outcome === "failed" ? (e.error ?? "") : null,
        messages: s.messages.map((m) => (m.role === "assistant" && !m.done ? { ...m, done: true } : m)),
      }
    case "text": {
      const idx = s.messages.findIndex((m) => m.id === e.messageId)
      const current = idx >= 0 ? s.messages[idx] : undefined
      const base: Extract<AppMessage, { role: "assistant" }> =
        current?.role === "assistant" ? current : { id: e.messageId, role: "assistant", createdAt: Date.now(), parts: [], done: false, error: null }
      const parts = [...base.parts]
      while (parts.length <= e.ordinal) parts.push("")
      parts[e.ordinal] = e.text ?? parts[e.ordinal] + (e.delta ?? "")
      const next = { ...base, parts }
      const messages = idx >= 0 ? s.messages.map((m, i) => (i === idx ? next : m)) : [...s.messages, next]
      return { ...s, busy: true, messages, retry: null }
    }
    case "activity":
      if (e.status === "running") return { ...s, busy: true, activity: { id: e.id, kind: e.kind, detail: e.detail } }
      return s.activity?.id === e.id ? { ...s, activity: null } : s
    case "retry":
      return { ...s, retry: { attempt: e.attempt, error: e.error } }
    case "title":
      return { ...s, title: e.title }
    case "question":
      return { ...s, question: openQuestion(e.question) }
    case "ready":
    case "refresh":
      return s
  }
}

function openQuestion(q: Question | null): Question | null {
  return q && q.status === "pending" ? q : null
}

/** A pending message shows up in the server's page as a user message with the same text (or, for photos alone, with photos). */
function delivered(p: Pending, messages: AppMessage[]): boolean {
  return messages.some((m) => m.role === "user" && (p.text.trim() ? m.text.trim() === p.text.trim() : p.images.length > 0 && m.images.length > 0 && m.createdAt >= p.createdAt - 120_000))
}

/** Merge two ordered lists of messages; `b` is newer and wins. */
export function mergeMessages(a: AppMessage[], b: AppMessage[]): AppMessage[] {
  const fresh = new Map(b.map((m) => [m.id, m]))
  const out = a.map((m) => fresh.get(m.id) ?? m)
  const seen = new Set(a.map((m) => m.id))
  for (const m of b) if (!seen.has(m.id)) out.push(m)
  return out.sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
}

/** The text of an assistant message, as markdown. */
export function assistantText(m: Extract<AppMessage, { role: "assistant" }>): string {
  return m.parts.filter((p) => p.trim()).join("\n\n")
}
