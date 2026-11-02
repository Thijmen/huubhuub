import type { AppMessage, AppTool } from "@server/protocol"
import { assistantText, type ChatState, type Pending } from "./chat-state"
import { dayLabel } from "./i18n"

export type ChatItem =
  | { kind: "day"; id: string; label: string }
  | { kind: "user"; message: Extract<AppMessage, { role: "user" }> }
  | { kind: "pending"; pending: Pending }
  | { kind: "huub"; message: Extract<AppMessage, { role: "assistant" }>; showAvatar: boolean; notes: AppTool[] }
  | { kind: "tools"; id: string; tools: AppTool[]; live?: boolean }

/** Messages as the list shows them, oldest first: day labels, bubbles, and the tools Huub used before replying. */
export function itemsOf(state: ChatState): ChatItem[] {
  const out: ChatItem[] = []
  let day = ""
  let tools: AppTool[] = []
  const flush = () => {
    if (tools.length) out.push({ kind: "tools", id: `tools-${tools[0]!.id}`, tools })
    tools = []
  }
  // Reminders and memories go inside the reply that follows them; plain tools go above it.
  const bubble = (m: Extract<AppMessage, { role: "assistant" }>) => {
    const notes = tools.filter((x) => x.note)
    tools = tools.filter((x) => !x.note)
    flush()
    out.push({ kind: "huub", message: m, showAvatar: out.at(-1)?.kind !== "huub", notes })
  }
  const dayOf = (at: number) => {
    const d = new Date(at).toDateString()
    if (d !== day) {
      flush()
      out.push({ kind: "day", id: `day-${d}`, label: dayLabel(at) })
      day = d
    }
  }
  for (const m of state.messages) {
    dayOf(m.createdAt)
    if (m.role === "user") {
      flush()
      out.push({ kind: "user", message: m })
      continue
    }
    tools.push(...(m.tools ?? []))
    if (assistantText(m) || m.error || !m.done) bubble(m)
  }
  flush()
  for (const p of state.pending) {
    dayOf(p.createdAt)
    out.push({ kind: "pending", pending: p })
  }
  // This reply's tools, until the server's messages have them: right after what was asked.
  const shown = new Set(state.messages.flatMap((m) => (m.role === "assistant" ? (m.tools ?? []).map((x) => x.id) : [])))
  const live = state.tools.filter((x) => !shown.has(x.id))
  if (live.length) {
    let at = out.length
    while (at > 0 && out[at - 1]!.kind === "huub") at--
    out.splice(at, 0, { kind: "tools", id: "live-tools", tools: live, live: state.busy })
  }
  return out
}
