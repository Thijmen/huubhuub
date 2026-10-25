import type { Api } from "grammy"
import type { Chats } from "./chats"
import { parseModelRef } from "./config"
import { truncate } from "./format"
import type { Bridge, SessionEvent } from "./opencode"
import type { Questions } from "./question"
import { Reply } from "./reply"
import { formatTime } from "./schedule-spec"
import type { RunOutcome, Runner } from "./scheduler"
import { runCommand, type CommandResult } from "./shell-task"
import { isAppChat, type ChatKey, type Schedule } from "./store"

export const SILENT = "[SILENT]"
const SILENT_HINT = `\n\n(This is a scheduled job. If there is nothing worth reporting, reply with exactly ${SILENT} and nothing else.)`
export const COMMAND_TIMEOUT_MS = 15 * 60_000
/** How much pre-check output is handed to the agent. */
const PRECHECK_MAX = 20_000
const TELEGRAM_OUTPUT_MAX = 3500

export interface RunnerDeps {
  api: Api
  bridge: Bridge
  chats: Chats
  questions: Questions
  timeZone: () => string
  /** Who hears about background jobs. */
  allowedUsers: () => number[]
  workspace: string
  /** The environment commands run with: the agent's, plus a GitHub token when the app is connected. */
  commandEnv: (command: string) => Promise<Record<string, string | undefined>>
  /** Why the owner of a private chat can't spend anything right now, if they can't. */
  spendBlocked?: (chatId: number) => Promise<string | undefined>
}

/** Runs scheduled tasks: prompts in a fresh session, or shell commands in the workspace. Reports them in Telegram unless they run in the background. */
export class ScheduleRunner implements Runner {
  constructor(private readonly d: RunnerDeps) {}

  async notify(chatId: number | null, html: string): Promise<void> {
    const targets = chatId === null ? this.d.allowedUsers() : [chatId]
    for (const id of targets) {
      await this.d.chats.post({ chatId: id, threadId: 0 }, html).catch((err) => {
        if (chatId !== null) throw err
        console.error(`Couldn't notify ${id} about a background job`, err)
      })
    }
  }

  async start(s: Schedule, startedAt: number): Promise<{ sessionID: string | null; done: Promise<RunOutcome> }> {
    if (s.type === "command") return { sessionID: null, done: this.runCommandTask(s, s.command ?? "") }
    // A prompt posted in someone's private chat spends on their account.
    const blocked = s.chatId !== null && s.chatId > 0 ? await this.d.spendBlocked?.(s.chatId) : undefined
    if (blocked) {
      await this.notify(s.chatId, `⏭ Skipped <b>${escape(s.name)}</b>. ${escape(blocked)}`).catch((err) => console.error("Couldn't report a skipped run", err))
      return { sessionID: null, done: Promise.resolve({ status: "skipped", error: blocked }) }
    }
    let prompt = s.prompt
    if (s.command) {
      const pre = await this.exec(s.command)
      if (failed(pre)) return { sessionID: null, done: Promise.resolve({ status: "failed", error: `The pre-check ${failure(pre)}.`, output: pre.output }) }
      if (!pre.output.trim()) return { sessionID: null, done: Promise.resolve({ status: "silent", output: "" }) }
      prompt = withPrecheck(s.prompt, s.command, pre.output)
    }
    return this.startPrompt(s, startedAt, prompt)
  }

  private exec(command: string): Promise<CommandResult> {
    return this.d.commandEnv(command).then((env) => runCommand(command, { cwd: this.d.workspace, env, timeoutMs: COMMAND_TIMEOUT_MS }))
  }

  private async runCommandTask(s: Schedule, command: string): Promise<RunOutcome> {
    const r = await this.exec(command)
    const outcome: RunOutcome = failed(r) ? { status: "failed", error: `The command ${failure(r)}.`, output: r.output } : { status: "ok", output: r.output }
    if (s.chatId === null) return outcome
    if (s.silent && outcome.status === "ok" && !r.output.trim()) return { ...outcome, status: "silent" }
    await this.d.chats
      .post({ chatId: s.chatId, threadId: 0 }, commandReport(s, r))
      .catch((err) => console.error(`Couldn't post the output of scheduled command ${s.id}`, err))
    return outcome
  }

  private async startPrompt(s: Schedule, startedAt: number, prompt: string): Promise<{ sessionID: string; done: Promise<RunOutcome> }> {
    const { bridge, questions } = this.d
    const carry = { ...(s.model ? { model: parseModelRef(s.model) } : {}), ...(s.agent ? { agent: s.agent } : {}) }
    const chatId = s.chatId
    const sessionID = await bridge.createDetached(carry, { ...(chatId !== null ? { [isAppChat(chatId) ? "appChatId" : "telegramChatId"]: chatId } : {}), scheduleId: s.id })
    const run = new RunWatch(bridge, questions, sessionID)
    const silent = chatId !== null && s.silent

    let surface: ((preface?: (key: ChatKey) => Promise<void>) => Promise<ChatKey>) | undefined
    if (chatId !== null) {
      const title = `⏰ ${s.name} · ${formatTime(startedAt, this.d.timeZone(), startedAt)}`
      const intro = `⏰ <b>${escape(s.name)}</b>\n<i>${escape(truncate(s.prompt, 500))}</i>`
      surface = (preface) => this.d.chats.openScheduled(chatId, title, sessionID, intro, preface)
      if (!silent) await surface()
      else run.onQuestion(() => void this.reveal(surface!, run, ""))
    }

    await bridge.prompt(sessionID, silent ? prompt + SILENT_HINT : prompt).catch((err) => {
      run.dispose()
      throw err
    })

    const done = run.finished.then(async (outcome): Promise<RunOutcome> => {
      run.dispose()
      const output = run.text()
      if (!silent || run.revealed) return { ...outcome, output }
      if (outcome.status === "ok" && run.lastText().trim() === SILENT) return { status: "silent", output }
      await this.reveal(surface!, run, outcome.status === "failed" ? `⚠️ ${truncate(outcome.error ?? "The run failed.", 500)}` : "")
      return { ...outcome, output }
    })
    return { sessionID, done }
  }

  /** Post a silent run's held-back output in its own topic, once. */
  private async reveal(surface: (preface?: (key: ChatKey) => Promise<void>) => Promise<ChatKey>, run: RunWatch, footer: string): Promise<void> {
    if (run.revealed) return
    run.revealed = true
    const body = [run.text(), footer].filter(Boolean).join("\n\n")
    await surface(body ? (key) => new Reply(this.d.api, key).update(body) : undefined)
  }
}

function failed(r: CommandResult): boolean {
  return r.timedOut || r.exitCode !== 0
}

function failure(r: CommandResult): string {
  if (r.timedOut) return `timed out after ${COMMAND_TIMEOUT_MS / 60_000} minutes`
  return r.exitCode === null ? "was killed" : `exited with code ${r.exitCode}`
}

/** The prompt a pre-checked task sends: the user's prompt, then what the check printed. */
export function withPrecheck(prompt: string, command: string, output: string): string {
  const text = output.length > PRECHECK_MAX ? `…${output.slice(-PRECHECK_MAX)}` : output
  return `${prompt}\n\nOutput of \`${command}\`:\n\`\`\`\n${text.trimEnd()}\n\`\`\``
}

export function commandReport(s: Schedule, r: CommandResult): string {
  const status = r.timedOut ? "⏱ timed out" : r.exitCode === 0 ? "✅" : r.exitCode === null ? "⚠️ killed" : `⚠️ exit ${r.exitCode}`
  const out = r.output.trim()
  const shown = out.length > TELEGRAM_OUTPUT_MAX ? `…${out.slice(-TELEGRAM_OUTPUT_MAX)}` : out
  return `⚙️ <b>${escape(s.name)}</b> ${status}\n${shown ? `<pre>${escape(shown)}</pre>` : "<i>No output.</i>"}`
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
