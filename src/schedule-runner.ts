import type { Api } from "grammy"
import type { Chats } from "./chats"
import { parseModelRef } from "./config"
import { truncate } from "./format"
import type { Bridge, SessionEvent } from "./opencode"
import type { Questions } from "./question"
import { Reply } from "./reply"
import { formatTime } from "./schedule-spec"
import type { RunOutcome, Runner } from "./scheduler"
import type { ChatKey, Schedule } from "./store"

export const SILENT = "[SILENT]"
const SILENT_HINT = `\n\n(This is a scheduled job. If there is nothing worth reporting, reply with exactly ${SILENT} and nothing else.)`

/** Runs a scheduled prompt in a fresh session and reports it in Telegram. */
export class ScheduleRunner implements Runner {
  constructor(
    private readonly api: Api,
    private readonly bridge: Bridge,
    private readonly chats: Chats,
    private readonly questions: Questions,
    private readonly timeZone: () => string,
  ) {}

  notify(chatId: number, html: string): Promise<void> {
    return this.api.sendMessage(chatId, html, { parse_mode: "HTML" }).then(() => undefined)
  }

  async start(s: Schedule, startedAt: number): Promise<{ sessionID: string; done: Promise<RunOutcome> }> {
    const carry = { ...(s.model ? { model: parseModelRef(s.model) } : {}), ...(s.agent ? { agent: s.agent } : {}) }
    const sessionID = await this.bridge.createDetached(carry, { telegramChatId: s.chatId, scheduleId: s.id })
    const title = `⏰ ${s.name} · ${formatTime(startedAt, this.timeZone(), startedAt)}`
    const intro = `⏰ <b>${escape(s.name)}</b>\n<i>${escape(truncate(s.prompt, 500))}</i>`
    const surface = (preface?: (key: ChatKey) => Promise<void>) => this.chats.openScheduled(s.chatId, title, sessionID, intro, preface)

    const run = new RunWatch(this.bridge, this.questions, sessionID)
    if (!s.silent) await surface()
    else run.onQuestion(() => void this.reveal(surface, run, ""))

    await this.bridge.prompt(sessionID, s.silent ? s.prompt + SILENT_HINT : s.prompt).catch((err) => {
      run.dispose()
      throw err
    })

    const done = run.finished.then(async (outcome) => {
      run.dispose()
      if (!s.silent || run.revealed) return outcome
      if (outcome.status === "ok" && run.lastText().trim() === SILENT) return { status: "silent" } satisfies RunOutcome
      await this.reveal(surface, run, outcome.status === "failed" ? `⚠️ ${truncate(outcome.error ?? "The run failed.", 500)}` : "")
      return outcome
    })
    return { sessionID, done }
  }

  /** Post a silent run's held-back output in its own topic, once. */
  private async reveal(surface: (preface?: (key: ChatKey) => Promise<void>) => Promise<ChatKey>, run: RunWatch, footer: string): Promise<void> {
    if (run.revealed) return
    run.revealed = true
    const body = [run.text(), footer].filter(Boolean).join("\n\n")
    await surface(body ? (key) => new Reply(this.api, key).update(body) : undefined)
  }
}

/** Follows one session until its execution ends, keeping the text it produced. */
class RunWatch {
  revealed = false
  readonly finished: Promise<RunOutcome>
  private blocks = new Map<string, string>()
  private settle!: (o: RunOutcome) => void
  private offs: (() => void)[] = []

  constructor(
    bridge: Bridge,
    private readonly questions: Questions,
    private readonly sessionID: string,
  ) {
    this.finished = new Promise((resolve) => (this.settle = resolve))
    this.offs.push(bridge.subscribe(sessionID, (e) => this.onEvent(e)))
  }

  onQuestion(fn: () => void): void {
    this.offs.push(this.questions.subscribe(this.sessionID, (flow) => !flow.done && fn()))
  }

  text(): string {
    return [...this.blocks.values()].map((t) => t.trim()).filter(Boolean).join("\n\n")
  }

  lastText(): string {
    return [...this.blocks.values()].filter((t) => t.trim()).at(-1) ?? ""
  }

  dispose(): void {
    for (const off of this.offs) off()
    this.offs = []
  }

  private onEvent(e: SessionEvent): void {
    switch (e.type) {
      case "session.text.delta": {
        const key = `${e.data.assistantMessageID}:${e.data.ordinal}`
        this.blocks.set(key, (this.blocks.get(key) ?? "") + e.data.delta)
        break
      }
      case "session.text.ended":
        this.blocks.set(`${e.data.assistantMessageID}:${e.data.ordinal}`, e.data.text)
        break
      case "session.execution.succeeded":
        this.settle({ status: "ok" })
        break
      case "session.execution.failed":
        this.settle({ status: "failed", error: e.data.error.message })
        break
      case "session.execution.interrupted":
        this.settle({ status: "failed", error: e.data.reason === "user" ? "Stopped by the user." : `Interrupted (${e.data.reason}).`, counts: e.data.reason !== "user" })
        break
    }
  }
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
