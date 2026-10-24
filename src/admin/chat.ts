import type { Bridge, Host, SessionEvent } from "../opencode"
import type { Questions } from "../question"
import type { Store } from "../store"

type Message = Awaited<ReturnType<Host["message"]["list"]>>["data"][number]

const PAGE = 80
const MAX_STRING = 20_000
const MAX_PREVIEW_BYTES = 1_500_000
const HEARTBEAT_MS = 15_000
// Tool input streaming is noisy and the UI only needs the final call.
const SKIP_EVENTS = new Set(["session.tool.input.delta"])

/** One page of a conversation, newest last, with enough session info to render the header. */
export async function conversation(bridge: Bridge, store: Store, questions: Questions, sessionID: string, cursor?: string) {
  const [session, page, active] = await Promise.all([
    bridge.getSession(sessionID),
    bridge.host.message.list({ sessionID, order: "desc", limit: PAGE, ...(cursor ? { cursor } : {}) }),
    bridge.host.session.active().catch(() => ({}) as Record<string, unknown>),
  ])
  const key = store.bySession(sessionID)
  return {
    session: {
      id: session.id,
      title: session.title ?? null,
      model: session.model ? `${session.model.providerID}/${session.model.id}` : null,
      agent: session.agent ?? null,
      cost: session.cost,
      tokens: session.tokens,
      created: session.time.created,
      updated: session.time.updated,
    },
    key: key ? { chatId: key.chatId, threadId: key.threadId } : null,
    busy: sessionID in active,
    question: questions.pending(sessionID)?.snapshot() ?? null,
    messages: page.data.map(slim).reverse(),
    older: page.data.length === PAGE ? (page.cursor.next ?? null) : null,
  }
}

/** Server-sent events for one session. Ends when the client disconnects. */
export function eventStream(bridge: Bridge, questions: Questions, sessionID: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }
      const unsubscribe = bridge.subscribe(sessionID, (e: SessionEvent) => {
        if (!SKIP_EVENTS.has(e.type)) write(`event: session\ndata: ${JSON.stringify({ type: e.type, data: clip(e.data) })}\n\n`)
      })
      const offQuestions = questions.subscribe(sessionID, (flow) => {
        write(`event: question\ndata: ${JSON.stringify(flow.snapshot())}\n\n`)
      })
      const beat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS)
      cleanup = () => {
        unsubscribe()
        offQuestions()
        clearInterval(beat)
        cleanup = () => {}
        try {
          controller.close()
        } catch {}
      }
      signal.addEventListener("abort", () => cleanup())
      write("event: ready\ndata: {}\n\n")
    },
    cancel: () => cleanup(),
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
  })
}

/** Strip attachment payloads and oversized strings so history stays light in the browser. */
function slim(m: Message): unknown {
  if (m.type === "user") {
    const files = m.files?.map((f) => ({
      name: f.name ?? null,
      mime: f.mime,
      preview: f.mime.startsWith("image/") && f.data.length < MAX_PREVIEW_BYTES ? `data:${f.mime};base64,${f.data}` : null,
    }))
    return { ...clip({ ...m, files: undefined }), files }
  }
  if (m.type === "system") return clip(m, 2000)
  return clip(m)
}

function clip<T>(value: T, max = MAX_STRING): T {
  if (typeof value === "string") return (value.length > max ? `${value.slice(0, max)}\n… (${value.length - max} more characters)` : value) as T
  if (Array.isArray(value)) return value.map((v) => clip(v, max)) as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = clip(v, max)
    return out as T
  }
  return value
}

const TOOL_SCAN_MESSAGES = 1000
const TOOL_CALLS_MAX = 300

type ToolPart = Extract<Extract<Message, { type: "assistant" }>["content"][number], { type: "tool" }>

export interface ToolTally {
  name: string
  count: number
  errors: number
}

/**
 * Every tool call in a session, newest first, with a tally per tool. Code Mode wraps plugin and MCP tools
 * in an `execute` call; the tally counts the tools its script called instead.
 */
export async function toolCalls(bridge: Bridge, sessionID: string) {
  const messages: Message[] = []
  let cursor: string | undefined
  while (messages.length < TOOL_SCAN_MESSAGES) {
    const page = await bridge.host.message.list({ sessionID, order: "desc", limit: 200, ...(cursor ? { cursor } : {}) })
    messages.push(...page.data)
    cursor = page.cursor.next ?? undefined
    if (!cursor || page.data.length < 200) break
  }
  return { ...summariseTools(messages), partial: messages.length >= TOOL_SCAN_MESSAGES }
}

/** `messages` newest first. */
export function summariseTools(messages: Message[]) {
  const tally = new Map<string, ToolTally>()
  const calls: { messageID: string; inner: string[]; part: unknown }[] = []
  let total = 0
  for (const m of messages) {
    if (m.type !== "assistant") continue
    const parts = m.content.filter((c): c is ToolPart => c.type === "tool").reverse()
    for (const part of parts) {
      total++
      const inner = part.name === "execute" ? innerTools(part.state.input) : []
      const failed = part.state.status === "error"
      for (const name of inner.length ? inner : [part.name]) {
        const t = tally.get(name) ?? { name, count: 0, errors: 0 }
        t.count++
        if (failed) t.errors++
        tally.set(name, t)
      }
      if (calls.length < TOOL_CALLS_MAX) calls.push({ messageID: m.id, inner, part: clip(part, 4000) })
    }
  }
  return { total, tally: [...tally.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), calls }
}

/** Tools a Code Mode script calls: `tools.name(…)`, `tools.ns.name(…)` or `tools.ns["name"](…)`. */
export function innerTools(input: unknown): string[] {
  const code = typeof input === "object" && input && typeof (input as { code?: unknown }).code === "string" ? (input as { code: string }).code : ""
  const out = new Set<string>()
  for (const m of code.matchAll(/\btools\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])?\s*\(/g)) {
    out.add(m[2] ?? m[3] ?? m[1]!)
  }
  return [...out]
}
