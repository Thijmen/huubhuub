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
