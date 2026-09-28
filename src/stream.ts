import { InlineKeyboard, type Api } from "grammy"
import { describeTool, truncate } from "./format"
import type { Bridge, SessionEvent } from "./opencode"
import { shortID, type QuestionFlow, type Questions } from "./question"
import { Reply, threadParams } from "./reply"
import type { ChatKey } from "./store"

type TextBlock = { kind: "text"; key: string; text: string }
type ToolBlock = { kind: "tool"; id: string; name: string; label: string; status: "running" | "ok" | "error" }
type Block = TextBlock | ToolBlock

const EDIT_INTERVAL_MS = 1200
const TOOL_ICON = { running: "🔧", ok: "✅", error: "❌" } as const

/** Renders one OpenCode session into a Telegram chat, one reply per execution. */
export class ChatView {
  private blocks: Block[] = []
  private running = false
  /** The reply was split by a question; an empty remainder should not post "(no response)". */
  private resumed = false
  private footer = ""
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly reply: Reply
  private readonly unsubscribe: () => void
  private question: { formID: string; messageID?: Promise<number | undefined>; queue: Promise<void> } | undefined

  constructor(
    private readonly api: Api,
    private readonly bridge: Bridge,
    readonly key: ChatKey,
    readonly sessionID: string,
    private readonly questions: Questions,
    private readonly onTitle?: (title: string) => void,
  ) {
    this.reply = new Reply(api, key)
    const offEvents = bridge.subscribe(sessionID, (e) => this.onEvent(e))
    const offQuestions = questions.subscribe(sessionID, (flow) => this.onQuestion(flow))
    this.unsubscribe = () => {
      offEvents()
      offQuestions()
    }
    // A view created while a question is already open (e.g. a scheduled run that was quiet so far).
    const open = questions.pending(sessionID)
    if (open) queueMicrotask(() => this.onQuestion(open))
  }

  get busy(): boolean {
    return this.running
  }

  dispose(): void {
    this.unsubscribe()
    this.reply.stopTyping()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private onEvent(e: SessionEvent): void {
    switch (e.type) {
      case "session.execution.started":
        this.begin()
        break
      case "session.text.delta":
        this.textBlock(e.data.assistantMessageID, e.data.ordinal).text += e.data.delta
        this.schedule()
        break
      case "session.text.ended":
        this.textBlock(e.data.assistantMessageID, e.data.ordinal).text = e.data.text
        this.schedule()
        break
      case "session.tool.input.started":
        if (e.data.name === "question") break
        if (!this.running) this.begin()
        this.blocks.push({ kind: "tool", id: e.data.id, name: e.data.name, label: e.data.name, status: "running" })
        this.schedule()
        break
      case "session.tool.called":
        this.updateTool(e.data.id, (t) => (t.label = describeTool(t.name, e.data.input)))
        break
      case "session.tool.success":
        this.updateTool(e.data.id, (t) => (t.status = "ok"))
        break
      case "session.tool.failed":
        this.updateTool(e.data.id, (t) => (t.status = "error"))
        break
      case "session.retry.scheduled":
        this.footer = `⏳ Retrying (attempt ${e.data.attempt}): ${truncate(e.data.error.message, 200)}`
        this.schedule()
        break
      case "session.step.started":
        if (this.footer.startsWith("⏳")) this.footer = ""
        break
      case "session.execution.succeeded":
        this.end("")
        break
      case "session.execution.failed":
        this.end(`⚠️ ${truncate(e.data.error.message, 500)}`)
        break
      case "session.execution.interrupted":
        this.end(e.data.reason === "user" ? "⏹ Stopped" : `⏹ Interrupted (${e.data.reason})`)
        break
      case "session.renamed":
        this.onTitle?.(e.data.title)
        break
      case "permission.asked":
        // The container is the sandbox: approve anything the config still routes to "ask".
        void this.bridge.host.permission
          .reply({ sessionID: this.sessionID, requestID: e.data.id, decision: "once" })
          .catch((err) => console.error("permission reply failed", err))
        break
    }
  }

  private begin(): void {
    if (this.running) return
    this.running = true
    this.resumed = false
    this.blocks = []
    this.footer = ""
    this.reply.reset()
    this.reply.startTyping()
  }

  /** Finish the reply so far; output after the answer goes into a new message below the question. */
  private pauseForQuestion(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.reply.stopTyping()
    const body = this.renderBody()
    const flushed = body ? this.reply.update(body) : Promise.resolve()
    this.blocks = []
    this.footer = ""
    this.resumed = true
    this.reply.reset()
    return flushed
  }

  private onQuestion(flow: QuestionFlow): void {
    if (this.question?.formID !== flow.formID) {
      this.question = { formID: flow.formID, queue: flow.done ? Promise.resolve() : this.pauseForQuestion() }
    }
    const q = this.question
    q.queue = q.queue
      .then(() => this.syncQuestion(q, flow))
      .catch((err) => console.error("question message failed", err))
    if (flow.done && flow.status !== "cancelled" && this.running) this.reply.startTyping()
  }

  private async syncQuestion(q: NonNullable<ChatView["question"]>, flow: QuestionFlow): Promise<void> {
    const opts = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } }
    if (flow.done) {
      const id = await q.messageID
      const html = flow.summary()
      if (id) await this.api.editMessageText(this.key.chatId, id, html, opts).catch(ignoreUnmodified)
      else await this.api.sendMessage(this.key.chatId, html, { ...opts, ...threadParams(this.key) })
      return
    }
    const { html, keyboard } = flow.render()
    const kb = new InlineKeyboard(keyboard.map((row) => row.map((b) => InlineKeyboard.text(b.text, `q:${shortID(flow.formID)}:${b.action}`))))
    if (!q.messageID) {
      q.messageID = this.api
        .sendMessage(this.key.chatId, html, { ...opts, ...threadParams(this.key), reply_markup: kb })
        .then((m) => m.message_id)
      await q.messageID
      return
    }
    const id = await q.messageID
    if (id) await this.api.editMessageText(this.key.chatId, id, html, { ...opts, reply_markup: kb }).catch(ignoreUnmodified)
  }

  private end(footer: string): void {
    if (!this.running) return
    this.running = false
    this.footer = footer
    this.reply.stopTyping()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.resumed && !this.renderBody() && !footer) return
    void this.reply.update(this.render())
  }

  private textBlock(messageID: string, ordinal: number): TextBlock {
    if (!this.running) this.begin()
    const key = `${messageID}:${ordinal}`
    let block = this.blocks.find((b): b is TextBlock => b.kind === "text" && b.key === key)
    if (!block) this.blocks.push((block = { kind: "text", key, text: "" }))
    return block
  }

  private updateTool(id: string, fn: (t: ToolBlock) => void): void {
    const tool = this.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.id === id)
    if (!tool) return
    fn(tool)
    this.schedule()
  }

  private render(): string {
    const body = this.renderBody()
    const tail = this.running ? this.footer || "…" : this.footer
    return [body, tail].filter(Boolean).join("\n\n") || "(no response)"
  }

  private renderBody(): string {
    return this.blocks
      .map((b) => (b.kind === "text" ? b.text.trim() : `${TOOL_ICON[b.status]} \`${b.label.replace(/`/g, "'")}\``))
      .filter(Boolean)
      .join("\n\n")
  }

  private schedule(): void {
    if (this.timer || !this.running || this.questions.pending(this.sessionID)) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.running) void this.reply.update(this.render())
    }, EDIT_INTERVAL_MS)
  }
}

function ignoreUnmodified(err: unknown): void {
  if (!String(err).includes("message is not modified")) throw err
}
