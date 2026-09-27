import type { Api } from "grammy"
import { chunkText, markdownToHtml } from "./format"
import type { ChatKey } from "./store"

const NO_PREVIEW = { is_disabled: true } as const

/** A live, editable Telegram reply that can grow across several messages. */
export class Reply {
  private messages: { id: number; html: string }[] = []
  private typing: ReturnType<typeof setInterval> | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly api: Api,
    private readonly target: ChatKey,
  ) {}

  /** Start a new reply thread; later updates create fresh messages. */
  reset(): void {
    this.messages = []
  }

  /** Render markdown into the reply, editing existing messages and appending as needed. */
  update(markdown: string): Promise<void> {
    this.queue = this.queue.then(() => this.sync(markdown)).catch((err) => console.error("reply update failed", err))
    return this.queue
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

/** Outbound messages to the main chat (or a forum's General topic) must omit the thread ID. */
export function threadParams(target: ChatKey): { message_thread_id?: number } {
  return target.threadId ? { message_thread_id: target.threadId } : {}
}
