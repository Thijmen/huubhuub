import type { Api, Context } from "grammy"
import type { Config } from "./config"
import type { Attachment, Bridge } from "./opencode"
import { ChatView } from "./stream"
import type { Store } from "./store"
import type { Transcriber } from "./transcribe"

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** Owns per-chat views and turns Telegram input into OpenCode prompts. */
export class Chats {
  private views = new Map<number, ChatView>()

  constructor(
    private readonly api: Api,
    private readonly bridge: Bridge,
    private readonly store: Store,
    private readonly config: Config,
    private readonly transcriber: Transcriber | undefined,
  ) {}

  async view(chatId: number): Promise<ChatView> {
    const sessionID = await this.bridge.sessionFor(chatId)
    const current = this.views.get(chatId)
    if (current?.sessionID === sessionID) return current
    current?.dispose()
    const view = new ChatView(this.api, this.bridge, chatId, sessionID)
    this.views.set(chatId, view)
    return view
  }

  async reset(chatId: number): Promise<string> {
    const current = this.views.get(chatId)
    if (current?.busy) await this.bridge.interrupt(current.sessionID).catch(() => {})
    current?.dispose()
    this.views.delete(chatId)
    const sessionID = await this.bridge.resetSession(chatId)
    await this.view(chatId)
    return sessionID
  }

  async send(chatId: number, text: string, files: Attachment[] = []): Promise<void> {
    const view = await this.view(chatId)
    await this.bridge.prompt(view.sessionID, text, files)
  }

  async handleText(ctx: Context): Promise<void> {
    const text = ctx.message?.text
    if (!ctx.chat || !text) return
    await this.send(ctx.chat.id, text)
  }

  async handlePhoto(ctx: Context): Promise<void> {
    const photos = ctx.message?.photo
    if (!ctx.chat || !photos?.length) return
    const largest = photos[photos.length - 1]!
    const bytes = await this.download(largest.file_id, largest.file_size)
    const mime = sniffImage(bytes) ?? "image/jpeg"
    await this.send(ctx.chat.id, ctx.message?.caption || "Describe this image.", [
      { uri: toDataUri(bytes, mime), name: `photo.${mime.split("/")[1]}` },
    ])
  }

  async handleDocument(ctx: Context): Promise<void> {
    const doc = ctx.message?.document
    if (!ctx.chat || !doc) return
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
    await this.send(ctx.chat.id, caption, [{ uri: toDataUri(bytes, mime), name }])
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
    await ctx.replyWithChatAction("typing")
    const bytes = await this.download(voice.file_id, voice.file_size)
    const transcript = await this.transcriber.transcribeOgg(bytes)
    if (!transcript) {
      await ctx.reply("🎤 I couldn't make out any speech in that message.")
      return
    }
    await ctx.reply(`🎤 <i>${escape(transcript)}</i>`, {
      parse_mode: "HTML",
      reply_parameters: { message_id: ctx.message!.message_id },
    })
    const text = ctx.message?.caption ? `${ctx.message.caption}\n\n${transcript}` : transcript
    await this.send(ctx.chat.id, text)
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
