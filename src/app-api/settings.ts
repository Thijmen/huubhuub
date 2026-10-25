import { MemoryError, MEMORY_MAX_PER_USER, type Personas } from "../personas"
import { describe } from "../schedule-spec"
import type { ScheduleService } from "../schedule-service"
import type { Scheduler } from "../scheduler"
import type { SpendLimits } from "../spend-limits"
import { MEMORY_MODES, type MemoryMode as StoreMemoryMode, type Schedule, type Store } from "../store"
import type { MemorySettings, PersonaSettings, ScheduleItem, ScheduleList, Spending } from "./protocol"

export interface SettingsDeps {
  store: Store
  personas: Personas
  limits: Pick<SpendLimits, "spend">
  scheduler: Pick<Scheduler, "running" | "runNow" | "reschedule">
  schedules: Pick<ScheduleService, "delete">
  timeZone: () => string
}

export class SettingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A person's own settings, as the app shows and changes them. Everything is scoped to `personId`. */
export class AppSettings {
  constructor(private readonly d: SettingsDeps) {}

  persona(personId: number): PersonaSettings {
    const fallback = this.d.personas.personaFor(null)
    return {
      personaId: this.d.store.person(personId)?.personaId ?? null,
      defaultPersona: fallback ? { id: fallback.id, name: fallback.name } : null,
      personas: this.d.store.personas().map((p) => ({ id: p.id, name: p.name, summary: summarise(p.prompt) })),
    }
  }

  setPersona(personId: number, personaId: unknown): PersonaSettings {
    if (personaId !== null && (typeof personaId !== "number" || !this.d.store.persona(personaId))) throw new SettingsError(400, "That persona doesn't exist (anymore).")
    this.d.store.updatePerson(personId, { personaId })
    return this.persona(personId)
  }

  memory(personId: number): MemorySettings {
    return {
      mode: this.d.store.person(personId)?.memoryMode ?? null,
      effectiveMode: this.d.personas.memoryMode(personId),
      defaultMode: this.d.personas.defaultMemoryMode,
      memories: this.d.store.memories(personId).map((m) => ({ id: m.id, text: m.text, source: m.source, createdAt: m.createdAt })),
      max: MEMORY_MAX_PER_USER,
    }
  }

  setMemoryMode(personId: number, mode: unknown): MemorySettings {
    if (mode !== null && !MEMORY_MODES.includes(mode as StoreMemoryMode)) throw new SettingsError(400, "Unknown memory setting.")
    this.d.store.updatePerson(personId, { memoryMode: mode as StoreMemoryMode | null })
    return this.memory(personId)
  }

  addMemory(personId: number, text: unknown): MemorySettings {
    try {
      this.d.personas.add(personId, typeof text === "string" ? text : undefined, "user")
    } catch (err) {
      if (err instanceof MemoryError) throw new SettingsError(400, err.message)
      throw err
    }
    return this.memory(personId)
  }

  forget(personId: number, id: number): MemorySettings {
    const m = this.d.store.memory(id)
    if (!m || m.userId !== personId) throw new SettingsError(404, "That memory doesn't exist.")
    this.d.store.deleteMemory(id)
    return this.memory(personId)
  }

  forgetAll(personId: number): MemorySettings {
    this.d.store.clearMemories(personId)
    return this.memory(personId)
  }

  schedules(personId: number): ScheduleList {
    const tz = this.d.timeZone()
    return { timeZone: tz, schedules: this.ownSchedules(personId).map((s) => this.item(s, tz)) }
  }

  setPaused(personId: number, id: number, paused: unknown): ScheduleItem {
    if (typeof paused !== "boolean") throw new SettingsError(400, "Expected paused: true or false.")
    const s = this.ownSchedule(personId, id)
    this.d.store.updateSchedule(s.id, { paused, ...(paused ? {} : { failStreak: 0 }) })
    if (!paused) this.d.scheduler.reschedule(s.id)
    return this.item(this.d.store.schedule(s.id)!, this.d.timeZone())
  }

  runNow(personId: number, id: number): ScheduleItem {
    const s = this.ownSchedule(personId, id)
    try {
      this.d.scheduler.runNow(s.id)
    } catch (err) {
      throw new SettingsError(409, (err as Error).message)
    }
    return this.item(this.d.store.schedule(s.id)!, this.d.timeZone())
  }

  deleteSchedule(personId: number, id: number): void {
    this.d.schedules.delete(this.ownSchedule(personId, id))
  }

  async spending(personId: number): Promise<Spending> {
    const s = await this.d.limits.spend(personId)
    const period = (p: typeof s.day) => ({ spent: p.spent, limit: p.limit, resetsAt: p.resetsAt })
    return { exempt: s.exempt, day: period(s.day), month: period(s.month) }
  }

  /** Jobs that post in this person's private chats (Telegram and app). */
  private ownSchedules(personId: number): Schedule[] {
    const person = this.d.store.person(personId)
    const chats = new Set([person?.telegramId, person?.appChatId].filter((c): c is number => typeof c === "number"))
    return this.d.store.schedules().filter((s) => s.chatId !== null && chats.has(s.chatId))
  }

  private ownSchedule(personId: number, id: number): Schedule {
    const s = this.ownSchedules(personId).find((x) => x.id === id)
    if (!s) throw new SettingsError(404, "That scheduled task doesn't exist.")
    return s
  }

  private item(s: Schedule, tz: string): ScheduleItem {
    const last = this.d.store.runs(s.id, 1)[0]
    return {
      id: s.id,
      name: s.name,
      description: describe(s, tz),
      type: s.type,
      prompt: s.type === "prompt" ? s.prompt : "",
      nextAt: s.paused ? null : s.nextAt,
      paused: s.paused,
      running: this.d.scheduler.running(s.id),
      createdBy: s.createdBy,
      lastRun: last ? { status: last.status, at: last.startedAt } : null,
    }
  }
}

/** The first sentence or two of a persona's instructions, without Markdown. */
function summarise(prompt: string): string {
  const text = prompt
    .split("\n")
    .map((l) => l.replace(/^#+\s*|^[-*]\s+/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/[*_`]/g, "")
  return text.length > 140 ? `${text.slice(0, 139).replace(/\s\S*$/, "")}…` : text
}
