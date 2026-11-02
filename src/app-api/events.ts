import { describeTool } from "../activity"
import type { Host, SessionEvent } from "../opencode"
import type { AppEvent, AppMessage, AppTool } from "./protocol"

type Message = Awaited<ReturnType<Host["message"]["list"]>>["data"][number]

const MAX_IMAGE_BYTES = 1_500_000
const PREVIEW_CHARS = 160

/** OpenCode messages, oldest first, as the app shows them: what was said and which tools were used, without bookkeeping. */
export function toAppMessages(messages: readonly Message[]): AppMessage[] {
  const out: AppMessage[] = []
  for (const m of messages) {
    if (m.type === "user") {
      out.push({
        id: m.id,
        role: "user",
        createdAt: m.time.created,
        text: m.text,
        images: (m.files ?? [])
          .filter((f) => f.mime.startsWith("image/"))
          .map((f) => ({ name: f.name ?? null, uri: f.data.length < MAX_IMAGE_BYTES ? `data:${f.mime};base64,${f.data}` : null })),
      })
    } else if (m.type === "assistant") {
      const parts = m.content.flatMap((c) => (c.type === "text" && c.text.trim() ? [c.text] : []))
      const tools = m.content.flatMap((c): AppTool[] => {
        // Questions show up as their own card.
        if (c.type !== "tool" || c.name === "question") return []
        const status = c.state.status === "completed" ? "ok" : c.state.status === "error" ? "error" : "running"
        const input = c.state.input as Record<string, unknown> | undefined
        const note = status === "ok" ? noteOf(c.name, input) : undefined
        return [{ id: c.id, ...describeTool(c.name, input), status, ...(note ? { note } : {}) }]
      })
      const error = m.error ? errorText(m.error) : null
      if (!parts.length && !tools.length && !error && m.time.completed) continue
      out.push({ id: m.id, role: "assistant", createdAt: m.time.created, parts, ...(tools.length ? { tools } : {}), done: Boolean(m.time.completed), error })
    }
  }
  return out
}

/** The last thing said, as one line of plain text, for the conversation list and notifications. */
export function previewOf(messages: readonly AppMessage[], max = PREVIEW_CHARS): string | null {
  return lastSaid(messages, max)?.text ?? null
}

/** The last thing said and who said it. */
export function lastSaid(messages: readonly AppMessage[], max = PREVIEW_CHARS): { text: string; from: "user" | "assistant" } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const plain = plainText(m.role === "user" ? m.text : m.parts.join(" "))
    if (plain) return { text: plain.length > max ? `${plain.slice(0, max - 1)}…` : plain, from: m.role }
  }
  return null
}

/** Markdown to a single line: no formatting characters, no code blocks, collapsed whitespace. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s*>\s?/gm, "")
    // Underscores only mark emphasis around words; inside them (snake_case, file names) they stay.
    .replace(/(^|[^\w])_{1,2}([^_\n]+?)_{1,2}(?=[^\w]|$)/g, "$1$2")
    .replace(/[*`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Turns one session's OpenCode events into app events. One per stream: it remembers tool names, which only
 * the first event of a tool call carries.
 */
export class AppEvents {
  private tools = new Map<string, string>()

  map(e: SessionEvent): AppEvent | undefined {
    switch (e.type) {
      case "session.execution.started":
        return { type: "run.started" }
      case "session.execution.succeeded":
        this.tools.clear()
        return { type: "run.ended", outcome: "succeeded" }
      case "session.execution.failed":
        this.tools.clear()
        return { type: "run.ended", outcome: "failed", error: errorText(e.data.error) }
      case "session.execution.interrupted":
        this.tools.clear()
        return { type: "run.ended", outcome: "interrupted" }
      case "session.text.delta":
        return { type: "text", messageId: e.data.assistantMessageID, ordinal: e.data.ordinal, delta: e.data.delta }
      case "session.text.ended":
        return { type: "text", messageId: e.data.assistantMessageID, ordinal: e.data.ordinal, text: e.data.text }
      case "session.tool.input.started":
        if (e.data.name === "question") return undefined
        this.tools.set(e.data.id, e.data.name)
        return { type: "activity", id: e.data.id, ...describeTool(e.data.name, undefined), status: "running" }
      case "session.tool.called": {
        const name = this.tools.get(e.data.id)
        if (!name) return undefined
        return { type: "activity", id: e.data.id, ...describeTool(name, e.data.input as Record<string, unknown>), status: "running" }
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const name = this.tools.get(e.data.id)
        if (!name) return undefined
        return { type: "activity", id: e.data.id, ...describeTool(name, undefined), status: e.type === "session.tool.success" ? "ok" : "error" }
      }
      case "session.retry.scheduled":
        return { type: "retry", attempt: e.data.attempt, error: errorText(e.data.error) }
      case "session.renamed":
        return { type: "title", title: e.data.title }
      case "session.inbox.delivered":
      case "session.compaction.ended":
      case "session.revert.committed":
        return { type: "refresh" }
    }
    return undefined
  }
}

/** Reminders Huub set and things it saved to memory get a card of their own in the app. */
function noteOf(tool: string, input: Record<string, unknown> | undefined): AppTool["note"] {
  const str = (k: string) => (typeof input?.[k] === "string" ? (input[k] as string).trim().replace(/\s+/g, " ") : "")
  const short = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s)
  if (tool === "schedule_create") {
    const text = str("name") || str("prompt") || str("command")
    return text ? { type: "reminder", text: short(text) } : undefined
  }
  if (tool === "memory_save" || tool === "memory_update") {
    const text = str("text")
    return text ? { type: "memory", text: short(text) } : undefined
  }
  return undefined
}

function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
  return typeof err === "string" ? err : "Something went wrong."
}
