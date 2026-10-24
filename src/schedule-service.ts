import type { Bridge } from "./opencode"
import { defaultName, describe, firstRun, formatTime, parseWhen, SpecError, upcoming } from "./schedule-spec"
import type { Scheduler } from "./scheduler"
import type { Schedule, SchedulePatch, Store, TaskType } from "./store"

const NAME_MAX = 80
/** Agent-made jobs may not run more often than this, so a confused agent can't burn through tokens. */
export const AGENT_MIN_GAP_MS = 5 * 60_000
export const AGENT_MAX_SCHEDULES = 20

export interface TaskInput {
  name?: string
  when?: string
  type?: TaskType
  prompt?: string
  command?: string | null
  model?: string | null
  agent?: string | null
  silent?: boolean
  paused?: boolean
  /** null runs the job in the background. */
  chatId?: number | null
}

type Selection = Pick<Bridge, "models" | "agents">

/** Creating and editing scheduled tasks, with the same rules for the admin UI and the agent's tools. */
export class ScheduleService {
  constructor(
    private readonly store: Store,
    private readonly scheduler: Scheduler,
    private readonly bridge: Selection,
    private readonly timeZone: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: TaskInput & { chatId: number | null }, createdBy: Schedule["createdBy"] = "user"): Promise<Schedule> {
    const when = this.when(input.when ?? "")
    if (createdBy === "agent") this.checkAgentLimits(when)
    const task = await this.task({ type: input.type ?? "prompt", prompt: input.prompt ?? "", command: input.command ?? null, model: input.model ?? null, agent: input.agent ?? null })
    const s = this.store.createSchedule(
      {
        chatId: input.chatId,
        name: this.name(input.name) ?? defaultName(task.type === "command" ? task.command! : task.prompt),
        ...when,
        ...task,
        silent: Boolean(input.silent),
        nextAt: firstRun(when, this.now(), this.timeZone()),
        createdBy,
      },
      this.now(),
    )
    this.scheduler.refresh()
    return s
  }

  async update(s: Schedule, input: TaskInput): Promise<Schedule> {
    const patch: SchedulePatch = {}
    if (input.name !== undefined) {
      const name = this.name(input.name)
      if (!name) throw new SpecError("The name can't be empty.")
      patch.name = name
    }
    if (input.chatId !== undefined) patch.chatId = input.chatId
    if ([input.type, input.prompt, input.command, input.model, input.agent].some((v) => v !== undefined)) {
      Object.assign(
        patch,
        await this.task({
          type: input.type ?? s.type,
          prompt: input.prompt ?? s.prompt,
          command: input.command === undefined ? s.command : input.command,
          model: input.model === undefined ? s.model : input.model,
          agent: input.agent === undefined ? s.agent : input.agent,
        }),
      )
    }
    if (input.silent !== undefined) patch.silent = Boolean(input.silent)
    const now = this.now()
    if (input.when !== undefined) {
      const when = this.when(input.when)
      if (s.createdBy === "agent") this.checkAgentLimits(when, s.id)
      Object.assign(patch, when, { nextAt: firstRun(when, now, this.timeZone()) })
    }
    if (input.paused !== undefined) {
      patch.paused = input.paused
      if (!input.paused) {
        patch.failStreak = 0
        const kind = patch.kind ?? s.kind
        if (kind !== "once" && patch.nextAt === undefined) patch.nextAt = firstRun({ kind, spec: patch.spec ?? s.spec }, now, this.timeZone())
      }
    }
    const updated = this.store.updateSchedule(s.id, patch)!
    this.scheduler.refresh()
    return updated
  }

  delete(s: Schedule): void {
    this.store.deleteSchedule(s.id)
    this.scheduler.refresh()
  }

  preview(text: string) {
    const when = this.when(text)
    const tz = this.timeZone()
    return { ...when, description: describe(when, tz), upcoming: upcoming(when, this.now(), tz), timeZone: tz }
  }

  /** One line per job, for the agent. */
  summary(s: Schedule): string {
    const tz = this.timeZone()
    const state = this.scheduler.running(s.id) ? "running now" : s.paused ? "paused" : s.nextAt ? `next run ${formatTime(s.nextAt, tz, this.now())}` : "done"
    const what = s.type === "command" ? `runs \`${s.command}\`` : `prompt: ${JSON.stringify(s.prompt)}${s.command ? ` (only when \`${s.command}\` prints something)` : ""}`
    const where = s.chatId === null ? "background" : "posts in this chat"
    return `#${s.id} "${s.name}": ${describe(s, tz)}, ${state}; ${what}; ${where}${s.silent ? ", silent" : ""}${s.failStreak ? `, ${s.failStreak} failed in a row` : ""}`
  }

  private when(text: string) {
    return parseWhen(text, this.now(), this.timeZone())
  }

  private name(raw: string | undefined): string | undefined {
    const name = raw?.replace(/\s+/g, " ").trim().slice(0, NAME_MAX)
    return name || undefined
  }

  private async task(t: { type: TaskType; prompt: string; command: string | null; model: string | null; agent: string | null }) {
    if (t.type !== "prompt" && t.type !== "command") throw new SpecError(`Unknown task type ${t.type}.`)
    const command = t.command?.trim() || null
    if (t.type === "command") {
      if (!command) throw new SpecError("Write the command to run.")
      return { type: t.type, prompt: "", command, model: null, agent: null }
    }
    const prompt = t.prompt.trim()
    if (!prompt) throw new SpecError("Write the prompt to run.")
    await this.checkSelection(t.model || null, t.agent || null)
    return { type: t.type, prompt, command, model: t.model || null, agent: t.agent || null }
  }

  private async checkSelection(model: string | null, agent: string | null): Promise<void> {
    if (model) {
      const slash = model.indexOf("/")
      const known = (await this.bridge.models()).some((m) => slash > 0 && m.providerID === model.slice(0, slash) && m.id === model.slice(slash + 1))
      if (!known) throw new SpecError(`${model} isn't available.`)
    }
    if (agent && !(await this.bridge.agents()).some((a) => a.id === agent)) throw new SpecError(`Unknown agent ${agent}.`)
  }

  private checkAgentLimits(when: { kind: Schedule["kind"]; spec: string }, editing?: number): void {
    const runs = upcoming(when, this.now(), this.timeZone(), 4)
    const gap = Math.min(...runs.slice(1).map((t, i) => t - runs[i]!))
    if (gap < AGENT_MIN_GAP_MS) throw new SpecError(`Scheduled jobs may run at most every ${AGENT_MIN_GAP_MS / 60_000} minutes.`)
    const mine = this.store.schedules().filter((s) => s.createdBy === "agent" && s.id !== editing)
    if (editing === undefined && mine.length >= AGENT_MAX_SCHEDULES) {
      throw new SpecError(`There are already ${mine.length} agent-made schedules. Delete some first, or ask the user to make this one.`)
    }
  }
}
