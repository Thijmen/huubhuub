import type { Api } from "grammy"
import { describeTool, truncate } from "./format"
import type { Bridge, SessionEvent } from "./opencode"
import { Reply } from "./reply"

type TextBlock = { kind: "text"; key: string; text: string }
type ToolBlock = { kind: "tool"; id: string; name: string; label: string; status: "running" | "ok" | "error" }
type Block = TextBlock | ToolBlock

const EDIT_INTERVAL_MS = 1200
const TOOL_ICON = { running: "🔧", ok: "✅", error: "❌" } as const

/** Renders one OpenCode session into a Telegram chat, one reply per execution. */
export class ChatView {
  private blocks: Block[] = []
  private running = false
  private footer = ""
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly reply: Reply
  private readonly unsubscribe: () => void

  constructor(
    api: Api,
    private readonly bridge: Bridge,
    chatId: number,
    readonly sessionID: string,
  ) {
    this.reply = new Reply(api, chatId)
    this.unsubscribe = bridge.subscribe(sessionID, (e) => this.onEvent(e))
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
    this.blocks = []
    this.footer = ""
    this.reply.reset()
    this.reply.startTyping()
  }

  private end(footer: string): void {
    if (!this.running) return
    this.running = false
    this.footer = footer
    this.reply.stopTyping()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
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
    const body = this.blocks
      .map((b) => (b.kind === "text" ? b.text.trim() : `${TOOL_ICON[b.status]} \`${b.label.replace(/`/g, "'")}\``))
      .filter(Boolean)
      .join("\n\n")
    const tail = this.running ? this.footer || "…" : this.footer
    return [body, tail].filter(Boolean).join("\n\n") || "(no response)"
  }

  private schedule(): void {
    if (this.timer || !this.running) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.running) void this.reply.update(this.render())
    }, EDIT_INTERVAL_MS)
  }
}
