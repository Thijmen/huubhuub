import { fetch as streamingFetch } from "expo/fetch"
import type {
  AppEvent,
  ConversationList,
  ConversationPage,
  ConversationSummary,
  ImageUpload,
  Me,
  PairResponse,
  Question,
  QuestionAction,
  TranscribeResponse,
} from "@server/protocol"
import { t } from "./i18n"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** The server's app API, for one signed-in phone. */
export class Api {
  constructor(
    readonly server: string,
    private readonly token: string,
    /** The server no longer accepts this phone. */
    private readonly onSignedOut: () => void,
  ) {}

  static async pair(server: string, code: string, deviceName: string | null, platform: "android" | "ios"): Promise<PairResponse> {
    return call<PairResponse>(server, "POST", "/v1/pair", null, { code, deviceName, platform })
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await call<T>(this.server, method, path, this.token, body)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.onSignedOut()
      throw err
    }
  }

  me = () => this.request<Me>("GET", "/v1/me")
  conversations = () => this.request<ConversationList>("GET", "/v1/conversations")
  conversation = (id: string, cursor?: string) =>
    this.request<ConversationPage>("GET", `/v1/conversations/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)
  create = (text?: string, images: ImageUpload[] = []) =>
    this.request<ConversationSummary>("POST", "/v1/conversations", { ...(text ? { text } : {}), ...(images.length ? { images } : {}) })
  send = (id: string, text: string, images: ImageUpload[] = []) =>
    this.request<void>("POST", `/v1/conversations/${encodeURIComponent(id)}/messages`, { text, ...(images.length ? { images } : {}) })
  transcribe = (audio: string, mime: string) => this.request<TranscribeResponse>("POST", "/v1/transcribe", { audio, mime })
  stop = (id: string) => this.request<void>("POST", `/v1/conversations/${encodeURIComponent(id)}/stop`)
  answer = (id: string, formID: string, action: QuestionAction) =>
    this.request<Question | null>("POST", `/v1/conversations/${encodeURIComponent(id)}/question`, { formID, action })
  setPushToken = (token: string | null) => this.request<void>("PUT", "/v1/devices/current/push", { token })
  signOut = () => this.request<void>("DELETE", "/v1/devices/current")

  /** Follow a conversation's live events until `signal` aborts or the connection drops. */
  async events(id: string, onEvent: (e: AppEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await streamingFetch(`${this.server}/v1/conversations/${encodeURIComponent(id)}/events`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
      signal,
    })
    if (res.status === 401) this.onSignedOut()
    if (!res.ok || !res.body) throw new ApiError(res.status, t("genericError"))
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        try {
          onEvent(JSON.parse(data) as AppEvent)
        } catch {
          // A malformed event is skipped; the next refresh catches up.
        }
      }
    }
  }
}

async function call<T>(server: string, method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(server + path, {
      method,
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, t("offline"))
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new ApiError(res.status, res.status === 401 ? t("signedOut") : (json?.error ?? t("genericError")))
  return json as T
}
