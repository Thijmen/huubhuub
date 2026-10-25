import { AudioError } from "../audio"
import { sniffImage, UserError, type AppImage, type Chats } from "../chats"
import type { Config } from "../config"
import type { Bridge } from "../opencode"
import { parseAction, type QuestionAction as ServerQuestionAction, type Questions } from "../question"
import { SpendLimitError } from "../spend-limits"
import { isAppChat, type AppDevice, type ChatState, type Store } from "../store"
import { AccessError, type AppAccess } from "./access"
import { AppEvents, previewOf, toAppMessages } from "./events"
import { invitePage } from "./invite-page"
import {
  APP_API_VERSION,
  type AppEvent,
  type ConversationList,
  type ConversationPage,
  type ConversationSummary,
  type Me,
  type NewConversationRequest,
  type PairRequest,
  type PairResponse,
  type PushTokenRequest,
  type ImageUpload,
  type QuestionRequest,
  type SendRequest,
  type TranscribeRequest,
  type TranscribeResponse,
} from "./protocol"
import type { AppPush } from "./push"
import type { Transcriber } from "../transcribe"

const PAGE = 60
const LIST_LIMIT = 100
const MAX_TEXT = 20_000
const HEARTBEAT_MS = 15_000
const PAIR_WINDOW_MS = 15 * 60_000
const PAIR_PER_IP = 10
const PAIR_TOTAL = 60
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_AUDIO_BYTES = 15 * 1024 * 1024

export interface AppDeps {
  config: Config
  store: Store
  bridge: Bridge
  chats: Chats
  questions: Questions
  access: AppAccess
  push: AppPush
  /** Turns voice notes into text; undefined when the server has no AWS credentials. */
  transcriber?: Pick<Transcriber, "transcribeRecording">
  /** The Telegram bot's name, shown in the app. */
  serverName: () => string
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type Req = Bun.BunRequest
type Handler = (req: Req, device: AppDevice, server: Bun.Server<undefined>) => Promise<unknown> | unknown

/**
 * The phone app's API. Meant to be reachable from the internet (behind TLS), so it only does what a person
 * may do with their own conversations; everything else stays in the admin UI.
 */
export function startAppApi(d: AppDeps) {
  const pairs = new PairLimiter()

  const authed = (handler: Handler) => async (req: Req, server: Bun.Server<undefined>) => {
    const device = d.access.authenticate(req.headers.get("authorization"))
    if (!device) return json({ error: "Sign in again: this phone isn't connected to the server anymore." }, 401)
    return run(req, () => handler(req, device, server))
  }

  return Bun.serve({
    port: d.config.APP_PORT,
    hostname: d.config.APP_HOST,
    maxRequestBodySize: 25 * 1024 * 1024,
    routes: {
      "/health": { GET: () => json({ ok: true, apiVersion: APP_API_VERSION }) },
      "/pair": { GET: () => new Response(invitePage(d.config.APP_DOWNLOAD_URL), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }) },

      "/v1/pair": {
        POST: (req, server) =>
          run(req, async (): Promise<PairResponse> => {
            if (!pairs.allow(clientIp(req, server))) throw new HttpError(429, "Too many attempts. Try again in a few minutes.")
            const body = await read<PairRequest>(req)
            const name = typeof body.deviceName === "string" ? body.deviceName.trim().slice(0, 60) || null : null
            const platform = body.platform === "android" || body.platform === "ios" || body.platform === "web" ? body.platform : null
            const { token, device } = d.access.pair(String(body.code ?? "").trim(), name, platform)
            return { token, me: me(d, device) }
          }),
      },
      "/v1/me": { GET: authed((_, device) => me(d, device)) },
      "/v1/devices/current": {
        DELETE: authed((_, device) => {
          d.store.deleteDevice(device.id)
        }),
      },
      "/v1/devices/current/push": {
        PUT: authed(async (req, device) => {
          const { token } = await read<PushTokenRequest>(req)
          if (token !== null && (typeof token !== "string" || !/^(Exponent|Expo)PushToken\[.+\]$/.test(token))) throw new HttpError(400, "Expected an Expo push token.")
          d.store.setPushToken(device.id, token)
        }),
      },

      "/v1/conversations": {
        GET: authed(async (_, device): Promise<ConversationList> => {
          const threads = d.store.conversationsOf(device.personId, LIST_LIMIT)
          const active = await activeSessions(d)
          return { conversations: await Promise.all(threads.map((t) => summary(d, t, active))) }
        }),
        POST: authed(async (req, device): Promise<ConversationSummary> => {
          const body = await read<NewConversationRequest>(req).catch(() => ({}) as NewConversationRequest)
          const images = imageUploads(body.images)
          const text = body.text === undefined ? "" : messageText(body.text, images.length > 0)
          const { sessionID } = await d.chats.startFromApp(device.personId)
          if (text || images.length) await d.chats.sendFromApp(sessionID, device.personId, text, images)
          return summary(d, d.store.bySession(sessionID)!, await activeSessions(d))
        }),
      },
      "/v1/conversations/:id": {
        GET: authed(async (req, device): Promise<ConversationPage> => {
          const thread = owned(d, device, req)
          const cursor = new URL(req.url).searchParams.get("cursor") ?? undefined
          const [page, active] = await Promise.all([
            d.bridge.host.message.list({ sessionID: thread.sessionID, order: "desc", limit: PAGE, ...(cursor ? { cursor } : {}) }),
            activeSessions(d),
          ])
          const messages = toAppMessages([...page.data].reverse())
          return {
            conversation: await summary(d, thread, active, messages),
            messages,
            older: page.data.length === PAGE ? (page.cursor.next ?? null) : null,
            question: d.questions.pending(thread.sessionID)?.snapshot() ?? null,
          }
        }),
      },
      "/v1/conversations/:id/events": {
        GET: authed((req, device, server) => {
          const thread = owned(d, device, req)
          server.timeout(req, 0)
          return eventStream(d, thread.sessionID, req.signal)
        }),
      },
      "/v1/conversations/:id/messages": {
        POST: authed(async (req, device) => {
          const thread = owned(d, device, req)
          const body = await read<SendRequest>(req)
          const images = imageUploads(body.images)
          await d.chats.sendFromApp(thread.sessionID, device.personId, messageText(body.text ?? "", images.length > 0), images)
        }),
      },
      "/v1/transcribe": {
        POST: authed(async (req): Promise<TranscribeResponse> => {
          if (!d.transcriber) throw new HttpError(501, "This server can't transcribe voice notes.")
          const body = await read<TranscribeRequest>(req)
          const audio = decodeBase64(body.audio, MAX_AUDIO_BYTES, "recording")
          const text = await d.transcriber.transcribeRecording(audio, String(body.mime ?? "audio/mp4")).catch((err) => {
            if (err instanceof AudioError) throw new HttpError(400, err.message)
            throw err
          })
          if (!text) throw new HttpError(422, "I couldn't make out any speech.")
          return { text }
        }),
      },
      "/v1/conversations/:id/stop": {
        POST: authed(async (req, device) => {
          const thread = owned(d, device, req)
          await d.bridge.interrupt(thread.sessionID)
        }),
      },
      "/v1/conversations/:id/question": {
        POST: authed(async (req, device) => {
          const thread = owned(d, device, req)
          const body = await read<QuestionRequest>(req)
          const action = questionAction(body.action)
          const ok = await d.questions.act(thread.sessionID, String(body.formID ?? ""), action)
          if (!ok) throw new HttpError(409, "This question has already been answered.")
          return d.questions.pending(thread.sessionID)?.snapshot() ?? null
        }),
      },
    },
    fetch: () => json({ error: "Not found" }, 404),
    error: (err) => {
      console.error("app API failed", err)
      return json({ error: "Something went wrong on the server." }, 500)
    },
  })
}

async function run(req: Request, fn: () => Promise<unknown> | unknown): Promise<Response> {
  try {
    const result = await fn()
    return result instanceof Response ? result : json(result ?? { ok: true })
  } catch (err) {
    const status =
      err instanceof HttpError ? err.status : err instanceof SpendLimitError ? 402 : err instanceof AccessError ? 403 : err instanceof UserError ? 400 : 500
    if (status === 500) console.error(`app ${req.method} ${new URL(req.url).pathname} failed`, err)
    return json({ error: status === 500 ? "Something went wrong on the server." : (err as Error).message }, status)
  }
}

function me(d: AppDeps, device: AppDevice): Me {
  const person = d.store.person(device.personId)
  return {
    person: { id: device.personId, name: person?.name ?? null },
    device: { id: device.id, name: device.name },
    serverName: d.serverName(),
    apiVersion: APP_API_VERSION,
    features: { voice: Boolean(d.transcriber), telegram: person?.telegramId != null },
  }
}

/** The conversation in the URL, if it's one of this person's private conversations. */
function owned(d: AppDeps, device: AppDevice, req: Req): ChatState {
  const id = decodeURIComponent((req.params as Record<string, string>).id ?? "")
  const thread = id ? d.store.bySession(id) : undefined
  if (!thread || d.store.ownerOfChat(thread.chatId) !== device.personId) throw new HttpError(404, "That conversation doesn't exist.")
  return thread
}

async function activeSessions(d: AppDeps): Promise<Set<string>> {
  const active = await d.bridge.host.session.active().catch(() => ({}) as Record<string, unknown>)
  return new Set(Object.keys(active))
}

async function summary(d: AppDeps, t: ChatState, active: Set<string>, loaded?: ReturnType<typeof toAppMessages>): Promise<ConversationSummary> {
  const [session, messages] = await Promise.all([
    d.bridge.getSession(t.sessionID).catch(() => undefined),
    loaded ??
      d.bridge.host.message
        .list({ sessionID: t.sessionID, order: "desc", limit: 6 })
        .then((p) => toAppMessages([...p.data].reverse()))
        .catch(() => []),
  ])
  return {
    id: t.sessionID,
    title: session?.title ?? null,
    updatedAt: t.updatedAt,
    busy: active.has(t.sessionID),
    preview: previewOf(messages),
    telegram: !isAppChat(t.chatId),
  }
}

/** Server-sent events for one conversation, in the app's own format. Ends when the phone disconnects. */
function eventStream(d: AppDeps, sessionID: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  const events = new AppEvents()
  let cleanup = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const raw = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }
      const send = (e: AppEvent) => raw(`data: ${JSON.stringify(e)}\n\n`)
      const offEvents = d.bridge.subscribe(sessionID, (e) => {
        const mapped = events.map(e)
        if (mapped) send(mapped)
      })
      const offQuestions = d.questions.subscribe(sessionID, (flow) => send({ type: "question", question: flow.snapshot() }))
      const unwatch = d.push.watch(sessionID)
      const beat = setInterval(() => raw(": ping\n\n"), HEARTBEAT_MS)
      cleanup = () => {
        offEvents()
        offQuestions()
        unwatch()
        clearInterval(beat)
        cleanup = () => {}
        try {
          controller.close()
        } catch {}
      }
      signal.addEventListener("abort", () => cleanup())
      send({ type: "ready" })
    },
    cancel: () => cleanup(),
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } })
}

/** The text of a message; it may be empty when photos come along. */
function messageText(text: unknown, optional = false): string {
  if (typeof text !== "string" || !text.trim()) {
    if (optional && (text === undefined || typeof text === "string")) return ""
    throw new HttpError(400, "Type a message first.")
  }
  if (text.length > MAX_TEXT) throw new HttpError(400, `Keep messages under ${MAX_TEXT} characters.`)
  return text.trim()
}

/** Photos sent along with a message, checked to be images we can pass on. */
function imageUploads(uploads: unknown): AppImage[] {
  if (uploads === undefined || uploads === null) return []
  if (!Array.isArray(uploads)) throw new HttpError(400, "Expected a list of images.")
  if (uploads.length > MAX_IMAGES) throw new HttpError(400, `Send at most ${MAX_IMAGES} photos at once.`)
  return uploads.map((u: ImageUpload, i) => {
    const bytes = decodeBase64(u?.data, MAX_IMAGE_BYTES, "photo")
    const mime = sniffImage(bytes)
    if (!mime) throw new HttpError(400, `Photo ${i + 1} isn't a JPEG, PNG, GIF or WebP image.`)
    const name = typeof u.name === "string" && u.name.trim() ? u.name.trim().slice(0, 100) : undefined
    return { bytes, mime, ...(name ? { name } : {}) }
  })
}

function decodeBase64(data: unknown, max: number, what: string): Uint8Array {
  if (typeof data !== "string" || !data) throw new HttpError(400, `The ${what} is missing.`)
  // Base64 is 4/3 the size; refuse before decoding something huge.
  if (data.length > Math.ceil((max * 4) / 3) + 4) throw new HttpError(413, `The ${what} is too large.`)
  const bytes = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64")
  if (!bytes.length) throw new HttpError(400, `The ${what} is empty.`)
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function questionAction(action: unknown): ServerQuestionAction {
  const a = action as { type?: unknown; option?: unknown; text?: unknown } | undefined
  if (a?.type === "text" && typeof a.text === "string" && a.text.trim()) return { type: "text", text: a.text.trim().slice(0, MAX_TEXT) }
  const parsed =
    a?.type === "pick" ? parseAction(`p:${a.option}`) : a?.type === "toggle" ? parseAction(`t:${a.option}`) : a?.type === "submit" ? parseAction("s") : a?.type === "skip" ? parseAction("x") : undefined
  if (!parsed) throw new HttpError(400, "Unknown answer.")
  return parsed
}

/** Behind the TLS proxy the client is in X-Forwarded-For; the code is unguessable anyway, this only slows down noise. */
function clientIp(req: Request, server: Bun.Server<undefined>): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || server.requestIP(req)?.address || "unknown"
}

class PairLimiter {
  private hits: { ip: string; at: number }[] = []

  allow(ip: string, now = Date.now()): boolean {
    this.hits = this.hits.filter((h) => h.at > now - PAIR_WINDOW_MS)
    if (this.hits.length >= PAIR_TOTAL || this.hits.filter((h) => h.ip === ip).length >= PAIR_PER_IP) return false
    this.hits.push({ ip, at: now })
    return true
  }
}

async function read<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new HttpError(400, "Expected a JSON body.")
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } })
}
