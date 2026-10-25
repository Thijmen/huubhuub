import type { PromptSource } from "../chats"
import type { Bridge, SessionEvent } from "../opencode"
import { isAppChat, type ChatKey, type Store } from "../store"
import { plainText } from "./events"

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
const BODY_CHARS = 150
/** The Android notification channel the app creates for replies. */
export const PUSH_CHANNEL = "replies"

export interface PushMessage {
  to: string
  title: string
  body: string
  data: { conversationId?: string }
  sound: "default"
  channelId: string
}

type Ticket = { status: "ok"; id: string } | { status: "error"; message: string; details?: { error?: string } }
export type PushSender = (messages: PushMessage[]) => Promise<Ticket[]>

interface Deps {
  store: Pick<Store, "get" | "bySession" | "ownerOfChat" | "devicesOf" | "dropPushToken">
  bridge: Pick<Bridge, "transcript" | "getSession">
  /** Defaults to Expo's push API. */
  send?: PushSender
}

/**
 * Push notifications for the app: when a reply finishes or the agent asks something. Telegram notifies on its
 * own, so conversations that also live there only push for prompts sent from the app. Nobody gets a push for
 * a conversation they have open.
 */
export class AppPush {
  private watching = new Map<string, number>()
  private fromApp = new Set<string>()
  private readonly send: PushSender

  constructor(private readonly d: Deps) {
    this.send = d.send ?? sendExpo
  }

  /** A phone has the conversation open. Call the returned function when it closes. */
  watch(sessionID: string): () => void {
    this.watching.set(sessionID, (this.watching.get(sessionID) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const n = (this.watching.get(sessionID) ?? 1) - 1
      if (n > 0) this.watching.set(sessionID, n)
      else this.watching.delete(sessionID)
    }
  }

  onPrompt(sessionID: string, source: PromptSource): void {
    if (source === "app") this.fromApp.add(sessionID)
    else if (source === "telegram") this.fromApp.delete(sessionID)
  }

  async onEvent(e: SessionEvent): Promise<void> {
    if (e.type === "session.execution.succeeded") return this.reply(e.data.sessionID)
    if (e.type === "session.execution.failed") return this.reply(e.data.sessionID, errorText(e.data.error))
    if (e.type === "form.created") {
      const form = e.data.form as { sessionID: string; metadata?: { kind?: string }; fields?: { title?: string; description?: string }[] }
      if (form.metadata?.kind !== "question") return
      const field = form.fields?.[0]
      return this.notify(form.sessionID, `❓ ${field?.description || field?.title || "Huub has a question"}`)
    }
  }

  /** A notice for an app-only chat, where Telegram can't deliver it. */
  async notice(key: ChatKey, html: string): Promise<void> {
    const owner = this.d.store.ownerOfChat(key.chatId)
    if (owner === null) return
    await this.deliver(owner, "HuubHuub", clip(plainText(stripHtml(html))), this.d.store.get(key)?.sessionID)
  }

  private async reply(sessionID: string, error?: string): Promise<void> {
    if (!this.wants(sessionID)) return
    const body = error ? `⚠️ ${error}` : await this.replyText(sessionID)
    await this.notify(sessionID, body || "✅")
  }

  private wants(sessionID: string): boolean {
    const thread = this.d.store.bySession(sessionID)
    if (!thread) return false
    return isAppChat(thread.chatId) || this.fromApp.has(sessionID)
  }

  private async notify(sessionID: string, body: string): Promise<void> {
    if (!this.wants(sessionID) || this.watching.has(sessionID)) return
    const thread = this.d.store.bySession(sessionID)!
    const owner = this.d.store.ownerOfChat(thread.chatId)
    if (owner === null) return
    const title = (await this.d.bridge.getSession(sessionID).catch(() => undefined))?.title || "HuubHuub"
    await this.deliver(owner, title, clip(body), sessionID)
  }

  private async deliver(personId: number, title: string, body: string, conversationId?: string): Promise<void> {
    const tokens = this.d.store.devicesOf(personId).flatMap((d) => (d.pushToken ? [d.pushToken] : []))
    if (!tokens.length) return
    const messages = tokens.map((to) => ({ to, title, body, data: conversationId ? { conversationId } : {}, sound: "default" as const, channelId: PUSH_CHANNEL }))
    try {
      const tickets = await this.send(messages)
      tickets.forEach((t, i) => {
        if (t.status === "error" && t.details?.error === "DeviceNotRegistered") this.d.store.dropPushToken(messages[i]!.to)
        else if (t.status === "error") console.error(`Push to ${messages[i]!.to} failed: ${t.message}`)
      })
    } catch (err) {
      console.error("Couldn't send push notifications", err)
    }
  }

  private async replyText(sessionID: string): Promise<string> {
    const blocks = await this.d.bridge.transcript(sessionID).catch(() => [])
    const texts = blocks.flatMap((b) => (b.kind === "text" && b.text.trim() ? [b.text] : []))
    return plainText(texts.at(-1) ?? "")
  }
}

async function sendExpo(messages: PushMessage[]): Promise<Ticket[]> {
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(messages),
  })
  if (!res.ok) throw new Error(`Expo push API: HTTP ${res.status} ${await res.text().catch(() => "")}`)
  const json = (await res.json()) as { data?: Ticket[] }
  return json.data ?? []
}

function clip(text: string): string {
  return text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS - 1)}…` : text
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
  return "The reply failed."
}
