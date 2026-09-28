/** A pending `question` tool call, independent of Telegram: navigation, selection, answers and rendering. */

export interface QuestionField {
  key: string
  title: string
  question: string
  multiple: boolean
  options: { label: string; description?: string }[]
}

export type QuestionStatus = "pending" | "answered" | "skipped" | "timeout" | "cancelled"
export type AnswerValue = string | string[]
export type Button = { text: string; action: string }

export interface QuestionSnapshot {
  formID: string
  status: QuestionStatus
  index: number
  total: number
  fields: QuestionField[]
  selected: number[]
  answers: (AnswerValue | null)[]
  expiresAt: number
}

/** The subset of an OpenCode form field the question tool produces. */
export interface FormFieldLike {
  key: string
  type: string
  title?: string
  description?: string
  options?: { value: string; label: string; description?: string }[]
}

export function toFields(fields: readonly FormFieldLike[]): QuestionField[] {
  return fields.map((f) => ({
    key: f.key,
    title: f.title ?? "Question",
    question: f.description ?? "",
    multiple: f.type === "multiselect",
    options: (f.options ?? []).map((o) => ({ label: o.value ?? o.label, ...(o.description ? { description: o.description } : {}) })),
  }))
}

export class QuestionFlow {
  status: QuestionStatus = "pending"
  index = 0
  private selected = new Set<number>()
  private readonly answers: (AnswerValue | null)[]

  constructor(
    readonly formID: string,
    readonly sessionID: string,
    readonly fields: QuestionField[],
    readonly openedAt: number,
    readonly expiresAt: number,
  ) {
    this.answers = fields.map(() => null)
  }

  get done(): boolean {
    return this.status !== "pending"
  }

  get current(): QuestionField {
    return this.fields[this.index]!
  }

  /** Choose an option of a single-choice question. Returns true when every question is answered. */
  pick(option: number): boolean {
    if (this.done || this.current.multiple) return false
    const opt = this.current.options[option]
    if (!opt) return false
    return this.record(opt.label)
  }

  toggle(option: number): void {
    if (this.done || !this.current.multiple || !this.current.options[option]) return
    if (this.selected.has(option)) this.selected.delete(option)
    else this.selected.add(option)
  }

  /** Submit the ticked options of a multi-select question. */
  submit(): boolean {
    if (this.done || !this.current.multiple) return false
    const picks = [...this.selected].sort((a, b) => a - b).map((i) => this.current.options[i]!.label)
    return this.record(picks)
  }

  /** A typed answer replaces whatever was ticked. */
  typed(text: string): boolean {
    const value = text.trim()
    if (this.done || !value) return false
    return this.record(this.current.multiple ? [value] : value)
  }

  finish(status: Exclude<QuestionStatus, "pending" | "answered">): void {
    if (!this.done) this.status = status
  }

  private record(value: AnswerValue): boolean {
    this.answers[this.index] = value
    this.selected.clear()
    if (this.index < this.fields.length - 1) {
      this.index++
      return false
    }
    this.status = "answered"
    return true
  }

  /**
   * The reply sent to OpenCode. Cancelling a form interrupts the whole run, so a skipped or timed-out
   * question is answered with a note instead and the agent carries on.
   */
  answer(note?: string): Record<string, AnswerValue> {
    const out: Record<string, AnswerValue> = {}
    this.fields.forEach((f, i) => {
      const value = this.answers[i]
      if (value !== null && value !== undefined) out[f.key] = value
      else if (note) out[f.key] = f.multiple ? [note] : note
    })
    return out
  }

  snapshot(): QuestionSnapshot {
    return {
      formID: this.formID,
      status: this.status,
      index: this.index,
      total: this.fields.length,
      fields: this.fields,
      selected: [...this.selected],
      answers: [...this.answers],
      expiresAt: this.expiresAt,
    }
  }

  /** Telegram HTML and keyboard for the question on screen. */
  render(): { html: string; keyboard: Button[][] } {
    const q = this.current
    const counter = this.fields.length > 1 ? ` <i>(${this.index + 1}/${this.fields.length})</i>` : ""
    const lines = [`❓ <b>${escape(q.title)}</b>${counter}`]
    if (q.question) lines.push(escape(q.question))
    const described = q.options.filter((o) => o.description)
    if (described.length) {
      lines.push("")
      for (const o of described) lines.push(`• <b>${escape(o.label)}</b>: ${escape(o.description!)}`)
    }
    lines.push("", `<i>✏️ ${q.multiple ? "Tick options and submit, or type" : "Tap an option, or type"} your own answer.</i>`)

    const keyboard: Button[][] = q.options.map((o, i) => [
      q.multiple
        ? { text: `${this.selected.has(i) ? "☑" : "☐"} ${clip(o.label, 56)}`, action: `t:${i}` }
        : { text: clip(o.label, 60), action: `p:${i}` },
    ])
    keyboard.push(q.multiple ? [{ text: "✅ Submit", action: "s" }, { text: "✖ Skip", action: "x" }] : [{ text: "✖ Skip", action: "x" }])
    return { html: lines.join("\n"), keyboard }
  }

  /** The collapsed message once the question is over. */
  summary(): string {
    const timeoutMinutes = Math.round((this.expiresAt - this.openedAt) / 60_000)
    const lines = this.fields.map((f, i) => {
      const a = this.answers[i]
      const text = a === null || a === undefined ? "<i>no answer</i>" : `<b>${escape(Array.isArray(a) ? a.join(", ") || "(none)" : a)}</b>`
      return `❓ ${escape(f.title)} → ${text}`
    })
    const tail =
      this.status === "skipped"
        ? "✖ Skipped"
        : this.status === "timeout"
          ? `⏱ Timed out${timeoutMinutes ? ` after ${timeoutMinutes} min` : ""}`
          : this.status === "cancelled"
            ? "⏹ Cancelled"
            : ""
    return [...lines, tail].filter(Boolean).join("\n")
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export const SKIP_NOTE = "The user skipped this question. Proceed with your best judgement."
export const TIMEOUT_NOTE = "The user did not answer in time. Proceed with your best judgement."

export interface FormReplier {
  reply(sessionID: string, formID: string, answer: Record<string, AnswerValue>): Promise<void>
}

export type QuestionAction =
  | { type: "pick"; option: number }
  | { type: "toggle"; option: number }
  | { type: "submit" }
  | { type: "skip" }
  | { type: "text"; text: string }

type Listener = (flow: QuestionFlow) => void

/** Tracks the open question per session, its timeout, and who gets told when it changes. */
export class Questions {
  private flows = new Map<string, QuestionFlow>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private listeners = new Map<string, Set<Listener>>()

  constructor(
    private readonly replier: FormReplier,
    private readonly timeoutMinutes: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The open question of a session, if any. */
  pending(sessionID: string): QuestionFlow | undefined {
    const flow = this.flows.get(sessionID)
    return flow && !flow.done ? flow : undefined
  }

  byShortID(short: string): QuestionFlow | undefined {
    for (const flow of this.flows.values()) if (shortID(flow.formID) === short) return flow
    return undefined
  }

  subscribe(sessionID: string, fn: Listener): () => void {
    let set = this.listeners.get(sessionID)
    if (!set) this.listeners.set(sessionID, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0) this.listeners.delete(sessionID)
    }
  }

  open(sessionID: string, formID: string, fields: QuestionField[]): QuestionFlow {
    this.close(sessionID, "cancelled")
    const minutes = this.timeoutMinutes()
    const now = this.now()
    const flow = new QuestionFlow(formID, sessionID, fields, now, now + minutes * 60_000)
    this.flows.set(sessionID, flow)
    this.timers.set(sessionID, setTimeout(() => void this.expire(sessionID, formID), minutes * 60_000))
    this.emit(flow)
    return flow
  }

  /** Apply a button press or typed answer. Returns false when the question is no longer open. */
  async act(sessionID: string, formID: string, action: QuestionAction): Promise<boolean> {
    const flow = this.pending(sessionID)
    if (!flow || flow.formID !== formID) return false
    let complete = false
    switch (action.type) {
      case "pick":
        complete = flow.pick(action.option)
        break
      case "toggle":
        flow.toggle(action.option)
        break
      case "submit":
        complete = flow.submit()
        break
      case "text":
        complete = flow.typed(action.text)
        break
      case "skip":
        flow.finish("skipped")
        await this.settle(flow, SKIP_NOTE)
        return true
    }
    if (complete) await this.settle(flow)
    else this.emit(flow)
    return true
  }

  /** The run ended, OpenCode cancelled the form, or someone else answered it. */
  close(sessionID: string, status: "cancelled" | "answered", formID?: string): void {
    const flow = this.pending(sessionID)
    if (!flow || (formID && flow.formID !== formID)) return
    if (status === "cancelled") flow.finish("cancelled")
    else flow.status = "answered"
    this.clearTimer(sessionID)
    this.emit(flow)
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private async expire(sessionID: string, formID: string): Promise<void> {
    const flow = this.pending(sessionID)
    if (!flow || flow.formID !== formID) return
    flow.finish("timeout")
    await this.settle(flow, TIMEOUT_NOTE)
  }

  private async settle(flow: QuestionFlow, note?: string): Promise<void> {
    this.clearTimer(flow.sessionID)
    this.emit(flow)
    await this.replier.reply(flow.sessionID, flow.formID, flow.answer(note)).catch((err) => {
      console.error("question reply failed", err)
    })
  }

  private clearTimer(sessionID: string): void {
    clearTimeout(this.timers.get(sessionID))
    this.timers.delete(sessionID)
  }

  private emit(flow: QuestionFlow): void {
    for (const fn of this.listeners.get(flow.sessionID) ?? []) {
      try {
        fn(flow)
      } catch (err) {
        console.error("question listener failed", err)
      }
    }
  }
}

/** Open and close questions from OpenCode's form events, for every session. */
export function trackForms(questions: Questions, event: { type: string; data: any }): void {
  switch (event.type) {
    case "form.created": {
      const form = event.data.form
      if (form?.metadata?.kind === "question") questions.open(form.sessionID, form.id, toFields(form.fields))
      break
    }
    case "form.replied":
      questions.close(event.data.sessionID, "answered", event.data.id)
      break
    case "form.cancelled":
      questions.close(event.data.sessionID, "cancelled", event.data.id)
      break
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      questions.close(event.data.sessionID, "cancelled")
      break
  }
}

/** Telegram callback data is capped at 64 bytes. */
export function shortID(formID: string): string {
  return Bun.hash(formID).toString(36)
}

/** Parse the action part of a question button's callback data. */
export function parseAction(data: string): QuestionAction | undefined {
  const [kind, n] = data.split(":")
  const option = Number(n)
  if (kind === "p" && Number.isInteger(option)) return { type: "pick", option }
  if (kind === "t" && Number.isInteger(option)) return { type: "toggle", option }
  if (kind === "s") return { type: "submit" }
  if (kind === "x") return { type: "skip" }
  return undefined
}
