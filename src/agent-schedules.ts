import type { Bridge } from "./opencode"
import { describe, formatTime, SpecError } from "./schedule-spec"
import type { ScheduleService, TaskInput } from "./schedule-service"
import type { Scheduler } from "./scheduler"
import type { Schedule, Store, TaskType } from "./store"

export interface AgentScheduleInput {
  id?: number
  name?: string
  when?: string
  type?: TaskType
  prompt?: string
  command?: string | null
  silent?: boolean
  paused?: boolean
  deliver?: "chat" | "background"
}

/**
 * The schedule tools the agent gets through the OpenCode plugin. A conversation in a Telegram chat sees
 * that chat's jobs and the background ones; other sessions (background runs, the OpenCode web UI) see all.
 */
export class AgentSchedules {
  constructor(
    private readonly store: Store,
    private readonly service: ScheduleService,
    private readonly scheduler: Scheduler,
    private readonly bridge: Pick<Bridge, "selection">,
    private readonly timeZone: () => string,
  ) {}

  async call(op: string, sessionID: string, input: AgentScheduleInput): Promise<string> {
    switch (op) {
      case "list": {
        const list = this.visible(sessionID)
        return list.length ? list.map((s) => this.service.summary(s)).join("\n") : "No scheduled jobs yet."
      }
      case "create":
        return this.create(sessionID, input)
      case "update": {
        const s = this.find(sessionID, input.id)
        const updated = await this.service.update(s, { ...this.fields(input), ...(input.deliver ? { chatId: this.target(sessionID, input.deliver) } : {}) })
        return `Updated. ${this.service.summary(updated)}`
      }
      case "delete": {
        const s = this.find(sessionID, input.id)
        this.service.delete(s)
        return `Deleted #${s.id} "${s.name}".`
      }
      case "run": {
        const s = this.find(sessionID, input.id)
        this.scheduler.runNow(s.id)
        return `Started #${s.id} "${s.name}". ${s.chatId === null ? "It runs in the background; its output shows on the admin UI's Schedules page." : "Its output is posted in the chat."}`
      }
      default:
        throw new SpecError(`Unknown operation ${op}.`)
    }
  }

  private async create(sessionID: string, input: AgentScheduleInput): Promise<string> {
    const chatId = this.target(sessionID, input.deliver ?? (this.chatOf(sessionID) === null ? "background" : "chat"))
    const selection = (input.type ?? "prompt") === "prompt" ? await this.bridge.selection(sessionID).catch(() => ({ model: null, agent: null })) : {}
    const s = await this.service.create({ ...selection, ...this.fields(input), chatId }, "agent")
    const tz = this.timeZone()
    const next = s.nextAt ? `, first run ${formatTime(s.nextAt, tz)} (${tz})` : ""
    const where = chatId === null ? "It runs in the background; results show on the admin UI's Schedules page." : "Results are posted in this chat; the user can manage it with /schedules."
    return `Scheduled #${s.id} "${s.name}": ${describe(s, tz)}${next}. ${where}`
  }

  private fields(input: AgentScheduleInput): TaskInput {
    const { name, when, type, prompt, command, silent, paused } = input
    return { name, when, type, prompt, command, silent, paused }
  }

  private chatOf(sessionID: string): number | null {
    return this.store.bySession(sessionID)?.chatId ?? null
  }

  private target(sessionID: string, deliver: "chat" | "background"): number | null {
    if (deliver === "background") return null
    const chat = this.chatOf(sessionID)
    if (chat === null) throw new SpecError('This conversation isn\'t in a Telegram chat, so use deliver: "background".')
    return chat
  }

  private visible(sessionID: string): Schedule[] {
    const chat = this.chatOf(sessionID)
    const all = this.store.schedules()
    return chat === null ? all : all.filter((s) => s.chatId === chat || s.chatId === null)
  }

  private find(sessionID: string, id: number | undefined): Schedule {
    const s = this.visible(sessionID).find((x) => x.id === Number(id))
    if (!s) throw new SpecError(`There's no schedule #${id} here. List them first.`)
    return s
  }
}
