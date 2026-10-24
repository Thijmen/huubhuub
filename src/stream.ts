import { InlineKeyboard, type Api } from "grammy"
import { statusLine, toolActivity, VERBS } from "./activity"
import { truncate } from "./format"
import type { Bridge, SessionEvent, TranscriptBlock } from "./opencode"
import { shortID, type QuestionFlow, type Questions } from "./question"
import { Reply, threadParams, type StreamingMode } from "./reply"
import type { ChatKey } from "./store"

type TextBlock = { kind: "text"; key: string; text: string }
type ToolBlock = { kind: "tool"; id: string; name: string; input?: Record<string, unknown>; status: "running" | "ok" | "error" }
type Block = TextBlock | ToolBlock

const EDIT_INTERVAL_MS = 1200
const DRAFT_INTERVAL_MS = 500
/** How often the status line's timer refreshes without new events. */
const TICK_MS = { draft: 1000, edit: 3000 } as const
/** A run with no events for this long is checked against OpenCode, in case its end was missed. */
const STALL_MS = 20_000

/** Renders one OpenCode session into a Telegram chat, one reply per execution. */
export class ChatView {
  private blocks: Block[] = []
  private running = false
  /** The reply was split by a question; an empty remainder should not post "(no response)". */
  private resumed = false
  private footer = ""
  private timer: ReturnType<typeof setTimeout> | undefined
  private watchdog: ReturnType<typeof setInterval> | undefined
  private ticker: ReturnType<typeof setInterval> | undefined
  private lastEvent = 0
  private startedAt = 0
  /** Where in the verb list this run starts, so not every reply opens with the same word. */
  private verbSeed = 0
  /** One Reply per execution (and per part split off by a question), so a finishing run can't touch the next. */
  private reply: Reply
  private readonly unsubscribe: () => void
  private question: { formID: string; messageID?: Promise<number | undefined>; queue: Promise<void> } | undefined

  constructor(
    private readonly api: Api,
    private readonly bridge: Bridge,
    readonly key: ChatKey,
    readonly sessionID: string,
    private readonly questions: Questions,
    private readonly streaming: () => StreamingMode,
    private readonly onTitle?: (title: string) => void,
  ) {
    this.reply = this.newReply()
    const offEvents = bridge.subscribe(sessionID, (e) => this.onEvent(e))
    const offQuestions = questions.subscribe(sessionID, (flow) => this.onQuestion(flow))
    const offResync = bridge.onResync(() => void this.checkStalled(true))
    this.unsubscribe = () => {
      offEvents()
      offQuestions()
      offResync()
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
    this.reply.dispose()
    this.stopTimers()
  }

  /** The user pressed the draft's stop button: stop streaming and interrupt the run. */
  async stop(): Promise<void> {
    this.reply.halt()
    await this.bridge.interrupt(this.sessionID)
  }

  private newReply(): Reply {
    return new Reply(this.api, this.key, this.streaming)
  }

  private stopTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.ticker) clearInterval(this.ticker)
    this.timer = undefined
    this.watchdog = undefined
    this.ticker = undefined
  }

  private onEvent(e: SessionEvent): void {
    this.lastEvent = Date.now()
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
        this.blocks.push({ kind: "tool", id: e.data.id, name: e.data.name, status: "running" })
        this.schedule()
        break
      case "session.tool.called":
        this.updateTool(e.data.id, (t) => (t.input = e.data.input))
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
    this.lastEvent = this.startedAt = Date.now()
    this.verbSeed = Math.floor(Math.random() * VERBS.length)
    this.reply.dispose()
    this.reply = this.newReply()
    this.reply.startTyping()
    this.watchdog = setInterval(() => void this.checkStalled(), STALL_MS / 2)
    this.ticker = setInterval(() => this.schedule(), TICK_MS[this.reply.drafting ? "draft" : "edit"])
    this.schedule()
  }

  /** Finish a run whose end event never arrived (e.g. the event stream dropped), using what OpenCode stored. */
  private async checkStalled(force = false): Promise<void> {
    if (!this.running || this.questions.pending(this.sessionID)) return
    if (!force && Date.now() - this.lastEvent < STALL_MS) return
    const active = await this.bridge.isActive(this.sessionID).catch(() => true)
    if (active || !this.running) {
      this.lastEvent = Date.now()
      return
    }
    console.warn(`Session ${this.sessionID} finished without an end event; finalizing from storage`)
    this.end("")
  }

  /** Finish the reply so far; output after the answer goes into a new message below the question. */
  private pauseForQuestion(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.reply.stopTyping()
    const body = renderText(this.blocks)
    const flushed = body ? this.reply.finalize(body) : this.reply.discard()
    this.blocks = []
    this.footer = ""
    this.resumed = true
    this.reply = this.newReply()
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
    this.stopTimers()
    this.reply.stopTyping()
    void this.finish(this.reply, this.blocks, this.resumed, footer)
  }

  /**
   * Persist the finished reply. Live events can be lost, so prefer what OpenCode stored when it has at
   * least as much text. After a question the reply was split, so only the live remainder applies.
   */
  private async finish(reply: Reply, live: Block[], resumed: boolean, footer: string): Promise<void> {
    let blocks = live
    if (!resumed) {
      const stored = await this.bridge.transcript(this.sessionID).then(
        (t) => t.flatMap(toBlock),
        (err) => (console.error("transcript fetch failed", err), []),
      )
      if (stored.length && textLength(stored) >= textLength(live)) blocks = stored
    }
    const body = renderText(blocks)
    if (resumed && !body && !footer) return reply.dispose()
    await reply.finalize([body, footer].filter(Boolean).join("\n\n") || "(no response)")
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

  /** The reply so far with a status line under it; the status disappears once the reply is final. */
  private renderProgress(): string {
    const tool = this.blocks.findLast((b): b is ToolBlock => b.kind === "tool" && b.status === "running")
    const status = this.footer || statusLine(tool && toolActivity(tool.name, tool.input), Date.now() - this.startedAt, this.verbSeed)
    return [renderText(this.blocks), status].filter(Boolean).join("\n\n")
  }

  private schedule(): void {
    if (this.timer || !this.running || this.questions.pending(this.sessionID)) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        if (this.running) void this.reply.preview(this.renderProgress())
      },
      this.reply.drafting ? DRAFT_INTERVAL_MS : EDIT_INTERVAL_MS,
    )
  }
}

/** Only the answer text; tool calls show up in the status line while they run. */
function renderText(blocks: Block[]): string {
  return blocks
    .map((b) => (b.kind === "text" ? b.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
}

function toBlock(b: TranscriptBlock, i: number): Block[] {
  if (b.kind === "text") return [{ kind: "text", key: `stored:${i}`, text: b.text }]
  if (b.name === "question") return []
  return [{ kind: "tool", id: b.id, name: b.name, input: b.input, status: b.status }]
}

function textLength(blocks: Block[]): number {
  return blocks.reduce((n, b) => n + (b.kind === "text" ? b.text.trim().length : 0), 0)
}

function ignoreUnmodified(err: unknown): void {
  if (!String(err).includes("message is not modified")) throw err
}
