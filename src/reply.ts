import type { Api } from "grammy"
import { chunkText, markdownToHtml } from "./format"
import type { ChatKey } from "./store"

const NO_PREVIEW = { is_disabled: true } as const
/** Drafts vanish after 30s without an update; refresh them well before that. */
const DRAFT_KEEPALIVE_MS = 20_000
const FINALIZE_RETRY_MS = 2_000
/**
 * Minimum gap between the last draft update and the final message. Telegram can apply a draft that was
 * sent just before the final message after it, which leaves a stale draft ("✻ Pondering… 1s") on screen.
 */
const DRAFT_SETTLE_MS = 1_000

export type StreamingMode = "draft" | "edit"

/**
 * A live Telegram reply that can grow across several messages. In private chats it can stream as an
 * ephemeral draft (`sendMessageDraft`) and is only sent as real messages once finalized; elsewhere it
 * edits its messages in place.
 */
export class Reply {
  private messages: { id: number; html: string }[] = []
  private typing: ReturnType<typeof setInterval> | undefined
  private queue: Promise<void> = Promise.resolve()
  private draftID = nextDraftID()
  private draftsBroken = false
  private halted = false
  /** A draft is showing; cleared once the reply is persisted so late draft pushes are dropped. */
  private live = false
  private lastDraft: string | undefined
  private keepAlive: ReturnType<typeof setTimeout> | undefined
  /** When the last draft update was accepted by Telegram. */
  private lastDraftAt = 0

  constructor(
    private readonly api: Api,
    private readonly target: ChatKey,
    private readonly streaming: () => StreamingMode = () => "edit",
  ) {}

  /** Whether updates stream as a draft rather than as edited messages. Only private chats support drafts. */
  get drafting(): boolean {
    return !this.draftsBroken && this.target.chatId > 0 && this.streaming() === "draft"
  }

  /** The draft being streamed; a stop button press reports it back. */
  get currentDraft(): number {
    return this.draftID
  }

  /** Start a new reply thread; later updates create fresh messages and a fresh draft. */
  reset(): void {
    this.clearDraft()
    this.messages = []
    this.draftID = nextDraftID()
  }

  /** Render markdown into the reply, editing existing messages and appending as needed. */
  update(markdown: string): Promise<void> {
    this.clearDraft()
    return this.enqueue(() => this.sync(markdown), "reply update failed")
  }

  /** Show work in progress: a draft in private chats, otherwise an edit of the persistent messages. */
  preview(markdown: string): Promise<void> {
    if (this.halted) return this.queue
    if (!this.drafting) return this.update(markdown)
    this.live = true
    return this.enqueue(() => this.pushDraft(markdown), "draft update failed")
  }

  /** Persist the finished reply. Retries once so a transient failure doesn't leave a stale preview. */
  finalize(markdown: string): Promise<void> {
    this.clearDraft()
    return this.enqueue(async () => {
      await this.settleDraft()
      try {
        await this.sync(markdown)
      } catch (err) {
        console.error("final reply failed, retrying", err)
        await Bun.sleep(FINALIZE_RETRY_MS)
        await this.sync(markdown)
      }
    }, "final reply failed")
  }

  /** Stop showing progress (the user pressed stop); only `finalize` still writes. */
  halt(): void {
    this.halted = true
    this.clearDraft()
    this.stopTyping()
  }

  startTyping(): void {
    this.stopTyping()
    const tick = () =>
      void this.api.sendChatAction(this.target.chatId, "typing", threadParams(this.target)).catch(() => {})
    tick()
    this.typing = setInterval(tick, 4500)
  }

  stopTyping(): void {
    if (this.typing) clearInterval(this.typing)
    this.typing = undefined
  }

  dispose(): void {
    this.stopTyping()
    this.clearDraft()
  }

  /** Drop the draft without sending anything; resolves once a message may safely follow it. */
  discard(): Promise<void> {
    this.dispose()
    return this.enqueue(() => this.settleDraft(), "draft discard failed")
  }

  private enqueue(fn: () => Promise<void>, label: string): Promise<void> {
    this.queue = this.queue.then(fn).catch((err) => console.error(label, err))
    return this.queue
  }

  private clearDraft(): void {
    if (this.keepAlive) clearTimeout(this.keepAlive)
    this.keepAlive = undefined
    this.lastDraft = undefined
    this.live = false
  }

  /** Give the last draft update time to land before a real message replaces it. */
  private async settleDraft(): Promise<void> {
    const wait = this.lastDraftAt + DRAFT_SETTLE_MS - Date.now()
    if (this.lastDraftAt && wait > 0) await Bun.sleep(wait)
  }

  private async pushDraft(markdown: string): Promise<void> {
    if (!this.live) return
    // A draft holds one message; show the tail of a long reply. The whole text is sent on finalize.
    const chunk = chunkText(markdown).at(-1) ?? ""
    const base = { ...threadParams(this.target), can_stop: true }
    try {
      try {
        await this.api.sendMessageDraft(this.target.chatId, this.draftID, markdownToHtml(chunk), { ...base, parse_mode: "HTML" })
      } catch (err) {
        if (!String(err).includes("can't parse entities")) throw err
        await this.api.sendMessageDraft(this.target.chatId, this.draftID, chunk, base)
      }
    } catch (err) {
      console.warn("Message drafts are unavailable here; falling back to editing messages", err)
      this.draftsBroken = true
      await this.sync(markdown)
      return
    }
    this.lastDraftAt = Date.now()
    if (!this.live) return
    this.lastDraft = markdown
    if (this.keepAlive) clearTimeout(this.keepAlive)
    this.keepAlive = setTimeout(() => {
      this.keepAlive = undefined
      if (this.lastDraft !== undefined) void this.preview(this.lastDraft)
    }, DRAFT_KEEPALIVE_MS)
  }

  private async sync(markdown: string): Promise<void> {
    for (const [i, chunk] of chunkText(markdown).entries()) {
      const html = markdownToHtml(chunk)
      const existing = this.messages[i]
      if (existing?.html === html) continue
      if (existing) {
        await this.edit(existing.id, html, chunk)
        existing.html = html
      } else {
        this.messages[i] = { id: await this.send(html, chunk), html }
      }
    }
  }

  private async send(html: string, plain: string): Promise<number> {
    const base = { link_preview_options: NO_PREVIEW, ...threadParams(this.target) }
    try {
      return (await this.api.sendMessage(this.target.chatId, html, { ...base, parse_mode: "HTML" })).message_id
    } catch (err) {
      if (!String(err).includes("can't parse entities")) throw err
      return (await this.api.sendMessage(this.target.chatId, plain, base)).message_id
    }
  }

  private async edit(id: number, html: string, plain: string): Promise<void> {
    try {
      await this.api.editMessageText(this.target.chatId, id, html, { parse_mode: "HTML", link_preview_options: NO_PREVIEW })
    } catch (err) {
      const msg = String(err)
      if (msg.includes("message is not modified")) return
      if (!msg.includes("can't parse entities")) throw err
      await this.api.editMessageText(this.target.chatId, id, plain, { link_preview_options: NO_PREVIEW })
    }
  }
}

/** Draft IDs must be non-zero; a fresh one per reply keeps a new reply from animating out of the last. */
let lastDraftID = Math.floor(Math.random() * 1_000_000_000) + 1
function nextDraftID(): number {
  return ++lastDraftID
}

/** Outbound messages to the main chat (or a forum's General topic) must omit the thread ID. */
export function threadParams(target: ChatKey): { message_thread_id?: number } {
  return target.threadId ? { message_thread_id: target.threadId } : {}
}
