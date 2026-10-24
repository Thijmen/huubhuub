import type { Api, Context } from "grammy"
import type { Chat, User, UserFromGetMe } from "grammy/types"
import type { Config } from "./config"
import { truncate } from "./format"
import type { Attachment, Bridge } from "./opencode"
import type { Questions } from "./question"
import type { SpendLimits } from "./spend-limits"
import { threadParams } from "./reply"
import { ChatView } from "./stream"
import type { ChatKey, Store } from "./store"
import type { Transcriber } from "./transcribe"

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const NEW_TOPIC_NAME = "New conversation"

/** Owns per-thread views and turns Telegram input into OpenCode prompts. */
export class Chats {
  private views = new Map<string, ChatView>()
  private pendingAutoTitle = new Set<string>()

  constructor(
    private readonly api: Api,
    private readonly bridge: Bridge,
    private readonly store: Store,
    private readonly config: Config,
    private readonly transcriber: Transcriber | undefined,
    private readonly me: () => UserFromGetMe | undefined,
    readonly questions: Questions,
    private readonly limits?: Pick<SpendLimits, "check">,
  ) {}

  /** Refuse new work from someone who has reached a spending limit. Runs before anything costs money. */
  async guard(user: User | undefined): Promise<void> {
    if (user && this.limits) await this.limits.check(user.id)
  }

  async view(key: ChatKey): Promise<ChatView> {
    const sessionID = await this.bridge.sessionFor(key)
    const id = viewId(key)
    const current = this.views.get(id)
    if (current?.sessionID === sessionID) return current
    current?.dispose()
    const view = new ChatView(this.api, this.bridge, key, sessionID, this.questions, () => this.config.TELEGRAM_STREAMING, (title) => void this.renameTopic(key, title))
    this.views.set(id, view)
    return view
  }

  /** Whether new conversations in this chat get their own topic. */
  threaded(chat: Chat): boolean {
    if (this.config.THREAD_MODE === "off") return false
    if (chat.type === "private") return Boolean(this.me()?.has_topics_enabled)
    return chat.type === "supergroup" && Boolean(chat.is_forum)
  }

  /**
   * Start a new conversation. In threaded chats that is a new topic; otherwise the current
   * session is replaced in place. Returns where the conversation lives.
   */
  async startNew(ctx: Context): Promise<{ key: ChatKey; sessionID: string; topic: boolean }> {
    const from = keyOf(ctx)
    if (this.threaded(ctx.chat!)) {
      const topic = await this.createTopic(from)
      if (topic) return { ...topic, topic: true }
    }
    const current = this.views.get(viewId(from))
    if (current?.busy) await this.bridge.interrupt(current.sessionID).catch(() => {})
    current?.dispose()
    this.views.delete(viewId(from))
    const sessionID = await this.bridge.resetSession(from)
    await this.view(from)
    return { key: from, sessionID, topic: false }
  }

  private async createTopic(from: ChatKey): Promise<{ key: ChatKey; sessionID: string } | undefined> {
    try {
      const topic = await this.api.createForumTopic(from.chatId, NEW_TOPIC_NAME)
      const key = { chatId: from.chatId, threadId: topic.message_thread_id }
      const sessionID = await this.bridge.openThread(key, from)
      await this.view(key)
      return { key, sessionID }
    } catch (err) {
      console.error(`Couldn't create a topic in chat ${from.chatId}; continuing in place`, err)
      return undefined
    }
  }

  /**
   * Where a message should be answered. Messages sent outside any topic in a threaded private
   * chat open a fresh topic, so every new conversation gets its own thread.
   */
  private async route(ctx: Context, preview: string): Promise<ChatKey> {
    const key = keyOf(ctx)
    if (key.threadId || ctx.chat?.type !== "private" || !this.threaded(ctx.chat)) {
      this.adoptImplicitTopic(ctx, key)
      return key
    }
    const topic = await this.createTopic(key)
    if (!topic) return key
    await this.api
      .sendMessage(topic.key.chatId, `💬 ${truncate(preview, 500)}`, threadParams(topic.key))
      .catch((err) => console.error("topic intro failed", err))
    return topic.key
  }

  /** A topic Telegram named after the first message may be renamed once OpenCode picks a title. */
  private adoptImplicitTopic(ctx: Context, key: ChatKey): void {
    if (!key.threadId || this.store.get(key)) return
    const created = ctx.msg?.reply_to_message?.forum_topic_created
    if (created?.is_name_implicit) this.pendingAutoTitle.add(viewId(key))
  }

  private async renameTopic(key: ChatKey, title: string): Promise<void> {
    if (!key.threadId || !title.trim()) return
    const state = this.store.get(key)
    const pending = this.pendingAutoTitle.delete(viewId(key))
    if (!state?.autoTitle && !pending) return
    this.store.clearAutoTitle(key)
    await this.api
      .editForumTopic(key.chatId, key.threadId, { name: truncate(title.trim(), 128) })
      .catch((err) => console.error("topic rename failed", err))
  }

  /** A prompt typed in the admin portal. Echoed into the Telegram thread so the reply there has context. */
  async sendFromPortal(sessionID: string, text: string): Promise<void> {
    const flow = this.questions.pending(sessionID)
    if (flow) {
      await this.questions.act(sessionID, flow.formID, { type: "text", text })
      return
    }
    const key = this.store.bySession(sessionID)
    if (!key) return void (await this.bridge.prompt(sessionID, text))
    await this.api
      .sendMessage(key.chatId, `💻 <i>from portal</i>\n${escape(truncate(text, 3500))}`, { parse_mode: "HTML", ...threadParams(key) })
      .catch((err) => console.error("portal echo failed", err))
    await this.send(key, text)
  }

  /** Open a conversation from the portal: a new topic when the chat supports it, else a fresh session in place. */
  async startFromPortal(chatId: number): Promise<{ key: ChatKey; sessionID: string }> {
    const from = { chatId, threadId: 0 }
    const chat = await this.api.getChat(chatId).catch(() => undefined)
    if (chat && this.threaded(chat)) {
      const topic = await this.createTopic(from)
      if (topic) {
        await this.api
          .sendMessage(chatId, "🆕 New conversation started from the portal.", threadParams(topic.key))
          .catch((err) => console.error("topic intro failed", err))
        return topic
      }
    }
    const current = this.views.get(viewId(from))
    if (current?.busy) await this.bridge.interrupt(current.sessionID).catch(() => {})
    current?.dispose()
    this.views.delete(viewId(from))
    const sessionID = await this.bridge.resetSession(from)
    await this.view(from)
    await this.api.sendMessage(chatId, "🆕 New session started from the portal.").catch(() => {})
    return { key: from, sessionID }
  }

  /**
   * Give a scheduled run somewhere to talk: a new topic when the chat supports it, else the main
   * chat, whose session it replaces. Returns where the run lives.
   */
  async openScheduled(chatId: number, title: string, sessionID: string, intro: string, preface?: (key: ChatKey) => Promise<void>): Promise<ChatKey> {
    const main = { chatId, threadId: 0 }
    const chat = await this.api.getChat(chatId).catch(() => undefined)
    let key: ChatKey = main
    if (chat && this.threaded(chat)) {
      const topic = await this.api.createForumTopic(chatId, truncate(title, 128)).catch((err) => {
        console.error(`Couldn't create a topic for a scheduled run in chat ${chatId}; using the main chat`, err)
        return undefined
      })
      if (topic) key = { chatId, threadId: topic.message_thread_id }
    }
    this.store.set(key, sessionID, false)
    await this.api
      .sendMessage(chatId, intro, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...threadParams(key) })
      .catch((err) => console.error("schedule intro failed", err))
    await preface?.(key).catch((err) => console.error("schedule output failed", err))
    await this.view(key)
    return key
  }

  /** The session of a thread, or the chat's most recent one. */
  sessionIn(key: ChatKey): string | undefined {
    return (this.store.get(key) ?? this.store.latest(key.chatId))?.sessionID
  }

  /** Prompt the thread's session. `from` is the Telegram user who wrote it; the session takes on their persona and memories. */
  async send(key: ChatKey, text: string, files: Attachment[] = [], from?: User): Promise<void> {
    await this.guard(from)
    const view = await this.view(key)
    if (from) this.store.seePerson(from.id, [from.first_name, from.last_name].filter(Boolean).join(" ") || null, from.username ?? null)
    this.store.touch(key, from?.id)
    await this.bridge.prompt(view.sessionID, text, files)
  }

  /** While the agent waits on a question in this thread, a typed message answers it. */
  private pendingIn(key: ChatKey) {
    const sessionID = this.store.get(key)?.sessionID
    return sessionID ? this.questions.pending(sessionID) : undefined
  }

  private async answerPending(key: ChatKey, text: string): Promise<boolean> {
    const flow = this.pendingIn(key)
    if (!flow || !text.trim()) return false
    return this.questions.act(flow.sessionID, flow.formID, { type: "text", text })
  }

  async handleText(ctx: Context): Promise<void> {
    const text = ctx.message?.text
    if (!ctx.chat || !text) return
    if (await this.answerPending(keyOf(ctx), text)) return
    await this.guard(ctx.from)
    await this.send(await this.route(ctx, text), text, [], ctx.from)
  }

  async handlePhoto(ctx: Context): Promise<void> {
    const photos = ctx.message?.photo
    if (!ctx.chat || !photos?.length) return
    await this.guard(ctx.from)
    const largest = photos[photos.length - 1]!
    const bytes = await this.download(largest.file_id, largest.file_size)
    const mime = sniffImage(bytes) ?? "image/jpeg"
    const caption = ctx.message?.caption || "Describe this image."
    await this.send(await this.route(ctx, `🖼 ${caption}`), caption, [
      { uri: toDataUri(bytes, mime), name: `photo.${mime.split("/")[1]}` },
    ], ctx.from)
  }

  async handleDocument(ctx: Context): Promise<void> {
    const doc = ctx.message?.document
    if (!ctx.chat || !doc) return
    await this.guard(ctx.from)
    const bytes = await this.download(doc.file_id, doc.file_size)
    const name = doc.file_name ?? "file"
    const mime = sniffImage(bytes) ?? (isProbablyText(bytes) ? "text/plain" : undefined)
    if (!mime) {
      await ctx.reply(
        `⚠️ ${name} (${doc.mime_type ?? "unknown type"}) isn't supported. Send text files or PNG/JPEG/GIF/WebP images.`,
      )
      return
    }
    const caption = ctx.message?.caption || (IMAGE_TYPES.has(mime) ? "Describe this image." : `Take a look at ${name}.`)
    await this.send(await this.route(ctx, `📎 ${name}: ${caption}`), caption, [{ uri: toDataUri(bytes, mime), name }], ctx.from)
  }

  async handleVoice(ctx: Context): Promise<void> {
    const voice = ctx.message?.voice ?? ctx.message?.audio
    if (!ctx.chat || !voice) return
    if (!this.transcriber) {
      await ctx.reply("🎤 Voice messages are disabled: no AWS credentials are configured for Amazon Transcribe.")
      return
    }
    const mime = voice.mime_type ?? ""
    if (ctx.message?.audio && !/ogg|opus/.test(mime)) {
      await ctx.reply(`🎤 Only OGG/Opus audio can be transcribed (got ${mime || "unknown"}). Record a voice note instead.`)
      return
    }
    await this.guard(ctx.from)
    await ctx.replyWithChatAction("typing")
    const bytes = await this.download(voice.file_id, voice.file_size)
    const transcript = await this.transcriber.transcribeOgg(bytes)
    if (!transcript) {
      await ctx.reply("🎤 I couldn't make out any speech in that message.")
      return
    }
    if (this.pendingIn(keyOf(ctx))) {
      await ctx.reply(`🎤 <i>${escape(transcript)}</i>`, { parse_mode: "HTML", reply_parameters: { message_id: ctx.message!.message_id } })
      await this.answerPending(keyOf(ctx), transcript)
      return
    }
    const key = await this.route(ctx, `🎤 ${transcript}`)
    await this.api.sendMessage(key.chatId, `🎤 <i>${escape(transcript)}</i>`, {
      parse_mode: "HTML",
      ...threadParams(key),
      ...(key.threadId === keyOf(ctx).threadId ? { reply_parameters: { message_id: ctx.message!.message_id } } : {}),
    })
    const text = ctx.message?.caption ? `${ctx.message.caption}\n\n${transcript}` : transcript
    await this.send(key, text, [], ctx.from)
  }

  private async download(fileId: string, size?: number): Promise<Uint8Array> {
    if (size && size > MAX_DOWNLOAD_BYTES) throw new UserError("That file is larger than Telegram's 20 MB bot limit.")
    const file = await this.api.getFile(fileId)
    if (!file.file_path) throw new UserError("Telegram didn't return a download path for that file.")
    const res = await fetch(`https://api.telegram.org/file/bot${this.config.TELEGRAM_BOT_TOKEN}/${file.file_path}`)
    if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

export class UserError extends Error {}

/** The conversation a message or button press belongs to. */
export function keyOf(ctx: Context): ChatKey {
  const msg = ctx.msg
  return { chatId: ctx.chat!.id, threadId: msg?.is_topic_message ? (msg.message_thread_id ?? 0) : 0 }
}

function viewId(key: ChatKey): string {
  return `${key.chatId}:${key.threadId}`
}

function toDataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function sniffImage(b: Uint8Array): string | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp"
  return undefined
}

export function isProbablyText(b: Uint8Array): boolean {
  const sample = b.subarray(0, 8192)
  if (sample.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.length < b.length ? trimPartial(sample) : sample)
    return true
  } catch {
    return false
  }
}

function trimPartial(b: Uint8Array): Uint8Array {
  let end = b.length
  // Drop a trailing incomplete multi-byte UTF-8 sequence cut by the sample boundary.
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const byte = b[end - i]!
    if ((byte & 0xc0) === 0xc0) return b.subarray(0, end - i)
    if ((byte & 0x80) === 0) break
  }
  return b
}
