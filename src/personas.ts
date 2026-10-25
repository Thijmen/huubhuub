import { MEMORY_MODES, type Memory, type MemoryMode, type Person, type Persona, type Store } from "./store"

export const MEMORY_MAX_CHARS = 500
export const MEMORY_MAX_PER_USER = 100
export const PERSONA_MAX_CHARS = 20_000
const DEFAULT_MEMORY_MODE: MemoryMode = "explicit"

/** Ported from huub v1. Editable on the admin UI's Personas page. */
export const HUUB_PROMPT = `Je bent Huub, een vriendelijke en behulpzame assistent die via Telegram communiceert.

## Identiteit
- Je naam is Huub. Je bent nuchter, warm en behulpzaam, zoals een goede vriend die oprecht wil dat het goed met je gaat.
- Je hebt een duidelijk Nederlands karakter: direct, eerlijk, en met beide benen op de grond.
- Je gebruikt af en toe Nederlandse uitdrukkingen wanneer dat natuurlijk aanvoelt (bijv. "doe maar gewoon", "even de puntjes op de i").

## Taal
- Je antwoordt standaard in het Nederlands. Als iemand je in een andere taal aanspreekt, schakel je over naar die taal.
- Je schrijft helder en bondig. Geen wollig taalgebruik.
- Uitzondering: als je over code-aanpassingen praat, technische plannen maakt of details van pull requests deelt, doe je dat in het Engels. De gewone conversatie blijft Nederlands.

## Toon
- Warm en aanmoedigend, maar niet overdreven enthousiast. Geen overdaad aan uitroeptekens of emoji's.
- Geduldig: je neemt de tijd om dingen duidelijk uit te leggen.
- Direct en eerlijk, op een vriendelijke manier. Als iets niet klopt, zeg je dat gewoon.
- Als je iets niet weet, zeg je dat eerlijk. Je bent bescheiden en kunt best een grapje maken, maar je bent geen clown.

## Technisch
- Je helpt graag met programmeren, technische vragen en algemene kennis.
- Je geeft concrete, bruikbare antwoorden. Liever een goed voorbeeld dan een muur van tekst.
- Bij code-wijzigingen in een repository: werk altijd op een feature branch, commit nooit rechtstreeks op main/master, en vraag bevestiging voordat je een pull request aanmaakt. Geef de PR-URL terug als eindresultaat.

## Radio (KDH)
- Als de gebruiker het over "de radio" heeft, bedoelt die bijna altijd het eigen radiostation KDH (Kneiter Dikke Hits), dat via Home Assistant draait. Vraag niet om verduidelijking tenzij de context duidelijk iets anders aangeeft.
- Gebruik de KDH-skill voor radioverzoeken: aanzetten, volume, volgend nummer, wat er nu speelt, of een specifieke artiest of track zoeken en aanvragen ("speel iets van Chipz").
- Vertel kort wat je gevonden hebt en of het verzoek gelukt is.`

export interface AgentContext {
  /** Text to add to the system prompt; null leaves the session as OpenCode set it up. */
  system: string | null
  /** Whether the memory tools apply to this session. */
  memory: boolean
}

export class MemoryError extends Error {}

/**
 * Personas and long-term memory, per Telegram user. A session belongs to the user who last wrote in its
 * thread; in a private chat that's always the chat itself. Scheduled runs belong to their chat's user.
 */
export class Personas {
  constructor(
    private readonly store: Store,
    private readonly timeZone: () => string,
  ) {}

  /** Create the Huub persona on first start and make it the default. */
  seed(): void {
    if (this.store.getSetting("personas_seeded")) return
    if (!this.store.personas().length) {
      const huub = this.store.createPersona("Huub", HUUB_PROMPT)
      this.store.setSetting("default_persona", String(huub.id))
    }
    this.store.setSetting("personas_seeded", "1")
  }

  get defaultPersonaId(): number | null {
    const id = Number(this.store.getSetting("default_persona"))
    return Number.isInteger(id) && id > 0 && this.store.persona(id) ? id : null
  }

  setDefaultPersona(id: number | null): void {
    if (id !== null && !this.store.persona(id)) throw new MemoryError(`There's no persona #${id}.`)
    this.store.setSetting("default_persona", id === null ? undefined : String(id))
  }

  get defaultMemoryMode(): MemoryMode {
    return MEMORY_MODES.find((m) => m === this.store.getSetting("default_memory_mode")) ?? DEFAULT_MEMORY_MODE
  }

  setDefaultMemoryMode(mode: MemoryMode | null): void {
    if (mode !== null && !MEMORY_MODES.includes(mode)) throw new MemoryError(`Unknown memory mode ${mode}.`)
    this.store.setSetting("default_memory_mode", mode ?? undefined)
  }

  /** The persona a user gets: their own pick, else the default. */
  personaFor(userId: number | null): Persona | undefined {
    const own = userId === null ? null : this.store.person(userId)?.personaId
    const id = own ?? this.defaultPersonaId
    return id === null ? undefined : this.store.persona(id)
  }

  memoryMode(userId: number): MemoryMode {
    return this.store.person(userId)?.memoryMode ?? this.defaultMemoryMode
  }

  /** The person a session talks to, if any: whoever last wrote in its thread, else the private chat's owner. Groups have none. */
  userOf(sessionID: string): number | null {
    const thread = this.store.bySession(sessionID)
    if (thread) return thread.userId ?? this.store.ownerOfChat(thread.chatId)
    const run = this.store.runBySession(sessionID)
    const chatId = run ? this.store.schedule(run.scheduleId)?.chatId : null
    return chatId ? this.store.ownerOfChat(chatId) : null
  }

  /** Whether the bot started this session: a Telegram thread or a scheduled run. */
  private ours(sessionID: string): { group: boolean } | undefined {
    const thread = this.store.bySession(sessionID)
    if (thread) return { group: thread.chatId < 0 }
    const run = this.store.runBySession(sessionID)
    if (!run) return undefined
    const chatId = this.store.schedule(run.scheduleId)?.chatId ?? null
    return { group: chatId !== null && chatId < 0 }
  }

  /**
   * What the OpenCode plugin adds to a session's system prompt. Sessions the bot didn't start (subagents,
   * ones opened in the OpenCode web UI) are left alone.
   */
  context(sessionID: string, now = Date.now()): AgentContext {
    const ours = this.ours(sessionID)
    if (!ours) return { system: null, memory: false }
    const userId = this.userOf(sessionID)
    const person = userId === null ? undefined : (this.store.person(userId) ?? { id: userId, name: null, username: null, personaId: null, memoryMode: null, seenAt: null })
    const mode = person ? this.memoryMode(person.id) : "off"
    const system = buildSystem({
      persona: this.personaFor(userId),
      person,
      group: ours.group,
      mode,
      memories: person && mode !== "off" ? this.store.memories(person.id) : [],
      now,
      timeZone: this.timeZone(),
    })
    return { system, memory: mode !== "off" }
  }

  /** The system prompt a user's conversations would get right now, for the admin UI. */
  preview(userId: number, now = Date.now()): string {
    const person = this.store.person(userId) ?? { id: userId, name: null, username: null, personaId: null, memoryMode: null, seenAt: null }
    const mode = this.memoryMode(userId)
    return buildSystem({
      persona: this.personaFor(userId),
      person,
      group: false,
      mode,
      memories: mode === "off" ? [] : this.store.memories(userId),
      now,
      timeZone: this.timeZone(),
    })
  }

  /** The memory tools, scoped to the session's user. */
  agentMemory(op: string, sessionID: string, input: { id?: number; text?: string }): string {
    const userId = this.userOf(sessionID)
    if (userId === null) throw new MemoryError("This conversation isn't with a known Telegram user, so there's no memory to use.")
    if (this.memoryMode(userId) === "off") throw new MemoryError("Memory is turned off for this user.")
    switch (op) {
      case "save": {
        const m = this.add(userId, input.text, "agent")
        return `Saved memory #${m.id}.`
      }
      case "update": {
        const m = this.own(userId, input.id)
        this.store.updateMemory(m.id, cleanMemory(input.text))
        return `Updated memory #${m.id}.`
      }
      case "forget": {
        const m = this.own(userId, input.id)
        this.store.deleteMemory(m.id)
        return `Forgot memory #${m.id}.`
      }
      default:
        throw new MemoryError(`Unknown memory operation ${op}.`)
    }
  }

  add(userId: number, text: string | undefined, source: Memory["source"]): Memory {
    const clean = cleanMemory(text)
    const existing = this.store.memories(userId)
    if (existing.length >= MEMORY_MAX_PER_USER) throw new MemoryError(`Memory is full (${MEMORY_MAX_PER_USER} entries). Forget or merge some first.`)
    const dupe = existing.find((m) => m.text.toLowerCase() === clean.toLowerCase())
    if (dupe) return dupe
    return this.store.addMemory(userId, clean, source)
  }

  private own(userId: number, id: number | undefined): Memory {
    const m = id === undefined ? undefined : this.store.memory(Number(id))
    if (!m || m.userId !== userId) throw new MemoryError(`There's no memory #${id} for this user.`)
    return m
  }
}

export function cleanMemory(text: string | undefined): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim()
  if (!clean) throw new MemoryError("A memory needs some text.")
  if (clean.length > MEMORY_MAX_CHARS) throw new MemoryError(`Keep a memory under ${MEMORY_MAX_CHARS} characters; split it or summarise it.`)
  return clean
}

export function displayName(p: Pick<Person, "id" | "name" | "username"> | undefined): string {
  if (!p) return "the user"
  return p.name || (p.username ? `@${p.username}` : `user ${p.id}`)
}

const MEMORY_RULES: Record<Exclude<MemoryMode, "off">, (name: string) => string> = {
  explicit: (name) =>
    `Only save a memory when ${name} explicitly asks you to remember something ("remember that…", "onthoud dat…"). Don't save anything on your own initiative, and don't offer to.`,
  auto: (name) =>
    [
      `Lasting facts about ${name} are saved automatically after each reply, and ${name} is told when that happens, so you don't need to save those yourself.`,
      `Use the memory tools when ${name} explicitly asks you to remember, correct or forget something.`,
    ].join(" "),
}

function buildSystem(o: {
  persona: Persona | undefined
  person: Pick<Person, "id" | "name" | "username"> | undefined
  group: boolean
  mode: MemoryMode
  memories: Memory[]
  now: number
  timeZone: string
}): string {
  const name = displayName(o.person)
  const parts: string[] = []
  if (o.persona?.prompt.trim()) parts.push(`# Persona\nTake on this persona. It replaces your default name and personality; your tools and abilities stay the same.\n\n${o.persona.prompt.trim()}`)

  const date = new Intl.DateTimeFormat("en-GB", { timeZone: o.timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(o.now)
  const who = o.person ? `${name}${o.person.username && o.person.name ? ` (@${o.person.username})` : ""}` : "the bot's users"
  parts.push(
    [
      "# Conversation",
      `You're talking with ${who} through Telegram${o.group ? ", in a group chat" : ""}.`,
      `Today is ${date} (${o.timeZone}). Run \`date\` when you need the exact time.`,
      "Replies are shown in Telegram: keep them compact. Bold, italic, `code`, code blocks, links, lists and quotes render; tables don't, so use lists instead.",
    ].join("\n"),
  )

  const mode = o.mode
  if (o.person && mode === "off") parts.push(`# Memory\nMemory is turned off for ${name}: don't try to remember anything between conversations. The memory tools will refuse.`)
  else if (o.person && mode !== "off") {
    const list = o.memories.length ? o.memories.map((m) => `- #${m.id}: ${m.text}`).join("\n") : "(nothing yet)"
    parts.push(
      [
        "# Memory",
        `You have a long-term memory about ${name} that carries over between conversations. Use memory_save, memory_update and memory_forget to change it.`,
        MEMORY_RULES[mode](name),
        "Keep each memory one short, self-contained sentence. Update an existing memory rather than adding a near-duplicate, and forget or correct it whenever asked.",
        "Use what you remember when it's relevant, but don't bring it up for no reason.",
        "",
        `What you remember about ${name}:`,
        list,
      ].join("\n"),
    )
  }
  return parts.join("\n\n")
}
