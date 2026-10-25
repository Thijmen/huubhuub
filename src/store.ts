import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Person and chat IDs from here up belong to the app. Telegram user IDs fit in 52 bits, so the ranges never
 * collide, and these are still safe JavaScript integers.
 */
export const APP_ID_BASE = 2 ** 52

/** A chat that only exists in the app: nothing about it may be sent to Telegram. */
export function isAppChat(chatId: number): boolean {
  return chatId >= APP_ID_BASE
}

/** A conversation surface: a Telegram chat (or an app-only chat), optionally narrowed to one forum topic (thread). */
export interface ChatKey {
  chatId: number
  /** 0 when the chat has no topics or the message is outside a topic. */
  threadId: number
}

export interface ChatState extends ChatKey {
  sessionID: string
  /** The Telegram user who last sent a message here; whose persona and memories the session uses. */
  userId: number | null
  /** The bot created this topic, so it may rename it after the session title. */
  autoTitle: boolean
  updatedAt: number
  /** Kept at the top of the app's conversation list. */
  pinned: boolean
  /** Epoch ms when it was archived in the app; null when it isn't. */
  archivedAt: number | null
}

export interface McpRecord {
  name: string
  /** `null` marks a server from bot.opencode.jsonc that was removed in the admin UI. */
  config: Record<string, unknown> | null
}

export interface SkillSource {
  id: string
  /** `owner/repo` on GitHub. */
  repo: string
  /** Branch or tag; `null` follows the default branch. */
  ref: string | null
  /** The GitHub App installation that grants access; looked up again if it goes away. */
  installationId: number | null
  lastSyncAt: number | null
  lastCommit: string | null
  lastError: string | null
  failStreak: number
  createdAt: number
}

export type SkillSourcePatch = Partial<Pick<SkillSource, "ref" | "installationId" | "lastSyncAt" | "lastCommit" | "lastError" | "failStreak">>

export interface Persona {
  id: number
  name: string
  /** Instructions added to the system prompt: character, tone, language, house rules. */
  prompt: string
  createdAt: number
  updatedAt: number
}

/** `off`: no memory. `explicit`: only saves when asked to. `auto`: may also save lasting facts on its own. */
export type MemoryMode = "off" | "explicit" | "auto"
export const MEMORY_MODES: readonly MemoryMode[] = ["off", "explicit", "auto"]

export interface Person {
  /** The person ID: their Telegram user ID for people who started on Telegram, `APP_ID_BASE` and up for people who started in the app. */
  id: number
  /** Their Telegram user ID, when they use Telegram. */
  telegramId: number | null
  /** The chat their app-only conversations live in, once they have one. */
  appChatId: number | null
  name: string | null
  username: string | null
  /** `null` uses the default persona. */
  personaId: number | null
  /** `null` uses the default mode. */
  memoryMode: MemoryMode | null
  seenAt: number | null
  /** Their own spending limits in dollars; `null` uses the default. */
  spendDaily: number | null
  spendMonthly: number | null
  /** No spending limits at all, whatever the defaults. */
  spendExempt: boolean
}

export interface Memory {
  id: number
  userId: number
  text: string
  /** Who wrote it: the agent, the user through a command, or the admin UI. */
  source: "agent" | "user" | "admin"
  createdAt: number
  updatedAt: number
}

/** A phone signed in to the app. */
export interface AppDevice {
  id: string
  personId: number
  name: string | null
  platform: string | null
  /** Expo push token, once the app has registered one. */
  pushToken: string | null
  createdAt: number
  seenAt: number | null
}

export type ScheduleKind = "cron" | "interval" | "once"
/** `prompt` sends a prompt to the agent; `command` runs a shell command in the workspace. */
export type TaskType = "prompt" | "command"
export type RunStatus = "running" | "ok" | "failed" | "silent" | "skipped" | "missed"

export interface Schedule {
  id: number
  /** The Telegram chat runs are posted in; null runs in the background, visible in the admin UI only. */
  chatId: number | null
  name: string
  kind: ScheduleKind
  /** A cron expression or nickname, `every 30m`, or the ISO time of a one-off job. */
  spec: string
  type: TaskType
  /** Empty for command tasks. */
  prompt: string
  /** The command of a command task, or an optional pre-check for a prompt task: the prompt only runs when it prints something. */
  command: string | null
  /** `provider/model`, or null for the default. */
  model: string | null
  agent: string | null
  silent: boolean
  paused: boolean
  failStreak: number
  /** Epoch ms of the next run; null once a one-off job has fired. */
  nextAt: number | null
  createdBy: "user" | "agent"
  createdAt: number
}

export interface ScheduleRun {
  id: number
  scheduleId: number
  sessionID: string | null
  startedAt: number
  endedAt: number | null
  status: RunStatus
  error: string | null
  /** What a command printed, or the agent's reply; trimmed to the last few KB. */
  output: string | null
}

export type NewSchedule = Pick<Schedule, "chatId" | "name" | "kind" | "spec" | "prompt" | "model" | "agent" | "silent" | "nextAt"> &
  Partial<Pick<Schedule, "type" | "command" | "createdBy">>
export type SchedulePatch = Partial<Omit<Schedule, "id" | "createdAt" | "createdBy">>

const RUN_OUTPUT_MAX = 8000

const SKILL_SOURCE_COLUMNS: Record<keyof SkillSourcePatch, string> = {
  ref: "ref",
  installationId: "installation_id",
  lastSyncAt: "last_sync_at",
  lastCommit: "last_commit",
  lastError: "last_error",
  failStreak: "fail_streak",
}

const SCHEDULE_COLUMNS: Record<keyof SchedulePatch, string> = {
  chatId: "chat_id",
  name: "name",
  kind: "kind",
  spec: "spec",
  type: "type",
  prompt: "prompt",
  command: "command",
  model: "model",
  agent: "agent",
  silent: "silent",
  paused: "paused",
  failStreak: "fail_streak",
  nextAt: "next_at",
}

export class Store {
  private db: Database

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new Database(join(dataDir, "bot.sqlite"), { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run(`CREATE TABLE IF NOT EXISTS threads (
      chat_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      auto_title INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, thread_id)
    )`)
    this.db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    this.db.run("CREATE TABLE IF NOT EXISTS env_vars (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
    this.db.run("CREATE TABLE IF NOT EXISTS mcp_servers (name TEXT PRIMARY KEY, config TEXT, updated_at INTEGER NOT NULL)")
    this.migrateSchedules()
    this.db.run(schedulesTable("schedules"))
    this.db.run(`CREATE TABLE IF NOT EXISTS schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      session_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      output TEXT
    )`)
    if (!this.columns("schedule_runs").some((c) => c.name === "output")) this.db.run("ALTER TABLE schedule_runs ADD COLUMN output TEXT")
    this.db.run("CREATE INDEX IF NOT EXISTS schedule_runs_by_schedule ON schedule_runs (schedule_id, started_at DESC)")
    this.dropPatSkillSources()
    this.db.run(`CREATE TABLE IF NOT EXISTS skill_sources (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      ref TEXT,
      installation_id INTEGER,
      last_sync_at INTEGER,
      last_commit TEXT,
      last_error TEXT,
      fail_streak INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS skill_states (
      source_id TEXT NOT NULL REFERENCES skill_sources(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      PRIMARY KEY (source_id, skill_id)
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS people (
      user_id INTEGER PRIMARY KEY,
      name TEXT,
      username TEXT,
      persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
      memory_mode TEXT,
      seen_at INTEGER
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    this.db.run("CREATE INDEX IF NOT EXISTS memories_by_user ON memories (user_id, id)")
    const threadColumns = this.columns("threads").map((c) => c.name)
    if (!threadColumns.includes("user_id")) this.db.run("ALTER TABLE threads ADD COLUMN user_id INTEGER")
    if (!threadColumns.includes("pinned")) this.db.run("ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
    if (!threadColumns.includes("archived_at")) this.db.run("ALTER TABLE threads ADD COLUMN archived_at INTEGER")
    const peopleColumns = this.columns("people").map((c) => c.name)
    if (!peopleColumns.includes("spend_daily")) this.db.run("ALTER TABLE people ADD COLUMN spend_daily REAL")
    if (!peopleColumns.includes("spend_monthly")) this.db.run("ALTER TABLE people ADD COLUMN spend_monthly REAL")
    if (!peopleColumns.includes("spend_exempt")) this.db.run("ALTER TABLE people ADD COLUMN spend_exempt INTEGER NOT NULL DEFAULT 0")
    if (!peopleColumns.includes("telegram_id")) {
      // Until the app existed, every person was a Telegram user whose person ID is their Telegram ID.
      this.db.run("ALTER TABLE people ADD COLUMN telegram_id INTEGER")
      this.db.query("UPDATE people SET telegram_id = user_id WHERE user_id < ?").run(APP_ID_BASE)
    }
    if (!peopleColumns.includes("app_chat_id")) this.db.run("ALTER TABLE people ADD COLUMN app_chat_id INTEGER")
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS people_by_telegram ON people (telegram_id) WHERE telegram_id IS NOT NULL")
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS people_by_app_chat ON people (app_chat_id) WHERE app_chat_id IS NOT NULL")
    this.db.run(`CREATE TABLE IF NOT EXISTS app_devices (
      id TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT,
      platform TEXT,
      push_token TEXT,
      created_at INTEGER NOT NULL,
      seen_at INTEGER
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS app_invites (
      code_hash TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )`)
    this.db.run("PRAGMA foreign_keys = ON")
    this.migrateChats()
  }

  /** A development build stored a token per skill source; sources now go through the GitHub App and must be added again. */
  private dropPatSkillSources(): void {
    if (!this.columns("skill_sources").some((c) => c.name === "token")) return
    this.db.run("DROP TABLE IF EXISTS skill_states")
    this.db.run("DROP TABLE skill_sources")
  }

  private columns(table: string): { name: string; notnull: number }[] {
    return this.db.query<{ name: string; notnull: number }, []>(`PRAGMA table_info(${table})`).all()
  }

  /**
   * Schedules used to require a chat and only ran prompts. SQLite can't drop NOT NULL in place, so the
   * table is rebuilt; foreign keys are still off here, so the run history survives.
   */
  private migrateSchedules(): void {
    const cols = this.columns("schedules")
    if (!cols.length || cols.find((c) => c.name === "chat_id")?.notnull === 0) return
    const kept = "id, chat_id, name, kind, spec, prompt, model, agent, silent, paused, fail_streak, next_at, created_at"
    this.db.transaction(() => {
      this.db.run(schedulesTable("schedules_next"))
      this.db.run(`INSERT INTO schedules_next (${kept}) SELECT ${kept} FROM schedules`)
      this.db.run("DROP TABLE schedules")
      this.db.run("ALTER TABLE schedules_next RENAME TO schedules")
    })()
  }

  /** Earlier versions keyed sessions by chat only. */
  private migrateChats(): void {
    const legacy = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chats'").get()
    if (!legacy) return
    this.db.transaction(() => {
      this.db.run(`INSERT OR IGNORE INTO threads (chat_id, thread_id, session_id, updated_at)
        SELECT chat_id, 0, session_id, updated_at FROM chats`)
      this.db.run("DROP TABLE chats")
    })()
  }

  get(key: ChatKey): ChatState | undefined {
    const row = this.db
      .query<Row, [number, number]>("SELECT * FROM threads WHERE chat_id = ? AND thread_id = ?")
      .get(key.chatId, key.threadId)
    return row ? toState(row) : undefined
  }

  /** The most recently used conversation in a chat, across all of its threads. */
  latest(chatId: number): ChatState | undefined {
    const row = this.db
      .query<Row, [number]>("SELECT * FROM threads WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(chatId)
    return row ? toState(row) : undefined
  }

  /** A user's conversations: threads they last wrote in, plus their private chat's threads nobody has written in yet. */
  threadsOf(userId: number, limit = 100): ChatState[] {
    return this.db
      .query<Row, [number, number, number]>(
        "SELECT * FROM threads WHERE user_id = ? OR (user_id IS NULL AND chat_id = ?) ORDER BY updated_at DESC LIMIT ?",
      )
      .all(userId, userId, limit)
      .map(toState)
  }

  bySession(sessionID: string): ChatState | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM threads WHERE session_id = ?").get(sessionID)
    return row ? toState(row) : undefined
  }

  list(limit = 50): ChatState[] {
    return this.db
      .query<Row, [number]>("SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?")
      .all(limit)
      .map(toState)
  }

  set(key: ChatKey, sessionID: string, autoTitle = false): void {
    this.db
      .query(
        `INSERT INTO threads (chat_id, thread_id, session_id, auto_title, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, thread_id) DO UPDATE SET
           session_id = excluded.session_id, auto_title = excluded.auto_title, updated_at = excluded.updated_at`,
      )
      .run(key.chatId, key.threadId, sessionID, autoTitle ? 1 : 0, Date.now())
  }

  /** Stop renaming a topic, e.g. once it has been named or the user renamed it. */
  clearAutoTitle(key: ChatKey): void {
    this.db.query("UPDATE threads SET auto_title = 0 WHERE chat_id = ? AND thread_id = ?").run(key.chatId, key.threadId)
  }

  /** Mark a thread as used, optionally by `userId`, who becomes the person the session talks to. Writing in an archived conversation brings it back. */
  touch(key: ChatKey, userId?: number): void {
    if (userId === undefined)
      this.db.query("UPDATE threads SET updated_at = ? WHERE chat_id = ? AND thread_id = ?").run(Date.now(), key.chatId, key.threadId)
    else
      this.db
        .query("UPDATE threads SET updated_at = ?, user_id = ?, archived_at = NULL WHERE chat_id = ? AND thread_id = ?")
        .run(Date.now(), userId, key.chatId, key.threadId)
  }

  setPinned(key: ChatKey, pinned: boolean): void {
    this.db.query("UPDATE threads SET pinned = ? WHERE chat_id = ? AND thread_id = ?").run(pinned ? 1 : 0, key.chatId, key.threadId)
  }

  setArchived(key: ChatKey, archived: boolean, now = Date.now()): void {
    // Archiving unpins: pinned means "on top of the list".
    if (archived) this.db.query("UPDATE threads SET archived_at = ?, pinned = 0 WHERE chat_id = ? AND thread_id = ?").run(now, key.chatId, key.threadId)
    else this.db.query("UPDATE threads SET archived_at = NULL WHERE chat_id = ? AND thread_id = ?").run(key.chatId, key.threadId)
  }

  delete(key: ChatKey): void {
    this.db.query("DELETE FROM threads WHERE chat_id = ? AND thread_id = ?").run(key.chatId, key.threadId)
  }

  getSetting(key: string): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value
  }

  setSetting(key: string, value: string | undefined): void {
    if (value === undefined) this.db.query("DELETE FROM settings WHERE key = ?").run(key)
    else
      this.db
        .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value)
  }

  envVars(): { name: string; value: string; updatedAt: number }[] {
    return this.db
      .query<{ name: string; value: string; updated_at: number }, []>("SELECT * FROM env_vars ORDER BY name")
      .all()
      .map((r) => ({ name: r.name, value: r.value, updatedAt: r.updated_at }))
  }

  setEnvVar(name: string, value: string): void {
    this.db
      .query(
        `INSERT INTO env_vars (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(name, value, Date.now())
  }

  deleteEnvVar(name: string): void {
    this.db.query("DELETE FROM env_vars WHERE name = ?").run(name)
  }

  mcpServers(): McpRecord[] {
    return this.db
      .query<{ name: string; config: string | null }, []>("SELECT name, config FROM mcp_servers ORDER BY name")
      .all()
      .map((r) => ({ name: r.name, config: r.config === null ? null : JSON.parse(r.config) }))
  }

  setMcpServer(name: string, config: Record<string, unknown> | null): void {
    this.db
      .query(
        `INSERT INTO mcp_servers (name, config, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      )
      .run(name, config === null ? null : JSON.stringify(config), Date.now())
  }

  deleteMcpServer(name: string): void {
    this.db.query("DELETE FROM mcp_servers WHERE name = ?").run(name)
  }

  schedules(chatId?: number | null): Schedule[] {
    const rows =
      chatId === undefined
        ? this.db.query<ScheduleRow, []>("SELECT * FROM schedules ORDER BY chat_id IS NULL, chat_id, id").all()
        : chatId === null
          ? this.db.query<ScheduleRow, []>("SELECT * FROM schedules WHERE chat_id IS NULL ORDER BY id").all()
          : this.db.query<ScheduleRow, [number]>("SELECT * FROM schedules WHERE chat_id = ? ORDER BY id").all(chatId)
    return rows.map(toSchedule)
  }

  schedule(id: number): Schedule | undefined {
    const row = this.db.query<ScheduleRow, [number]>("SELECT * FROM schedules WHERE id = ?").get(id)
    return row ? toSchedule(row) : undefined
  }

  createSchedule(s: NewSchedule, now = Date.now()): Schedule {
    const { id } = this.db
      .query<
        { id: number },
        [number | null, string, string, string, string, string, string | null, string | null, string | null, number, number | null, string, number]
      >(
        `INSERT INTO schedules (chat_id, name, kind, spec, type, prompt, command, model, agent, silent, next_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        s.chatId,
        s.name,
        s.kind,
        s.spec,
        s.type ?? "prompt",
        s.prompt,
        s.command ?? null,
        s.model,
        s.agent,
        s.silent ? 1 : 0,
        s.nextAt,
        s.createdBy ?? "user",
        now,
      )!
    return this.schedule(id)!
  }

  updateSchedule(id: number, patch: SchedulePatch): Schedule | undefined {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof SchedulePatch, unknown][]
    if (entries.length) {
      const sets = entries.map(([k]) => `${SCHEDULE_COLUMNS[k]} = ?`).join(", ")
      const values = entries.map(([, v]) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as (string | number | null)[]
      this.db.query(`UPDATE schedules SET ${sets} WHERE id = ?`).run(...values, id)
    }
    return this.schedule(id)
  }

  deleteSchedule(id: number): void {
    this.db.query("DELETE FROM schedules WHERE id = ?").run(id)
  }

  addRun(scheduleId: number, status: RunStatus, startedAt: number, error: string | null = null): number {
    const ended = status === "running" ? null : startedAt
    return this.db
      .query<{ id: number }, [number, number, number | null, string, string | null]>(
        "INSERT INTO schedule_runs (schedule_id, started_at, ended_at, status, error) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
      .get(scheduleId, startedAt, ended, status, error)!.id
  }

  setRunSession(runId: number, sessionID: string): void {
    this.db.query("UPDATE schedule_runs SET session_id = ? WHERE id = ?").run(sessionID, runId)
  }

  finishRun(runId: number, status: RunStatus, error: string | null = null, endedAt = Date.now(), output: string | null = null): void {
    this.db
      .query("UPDATE schedule_runs SET status = ?, error = ?, ended_at = ?, output = ? WHERE id = ?")
      .run(status, error, endedAt, output === null ? null : output.slice(-RUN_OUTPUT_MAX), runId)
  }

  runs(scheduleId: number, limit = 20): ScheduleRun[] {
    return this.db
      .query<RunRow, [number, number]>("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")
      .all(scheduleId, limit)
      .map(toRun)
  }

  runBySession(sessionID: string): ScheduleRun | undefined {
    const row = this.db.query<RunRow, [string]>("SELECT * FROM schedule_runs WHERE session_id = ?").get(sessionID)
    return row ? toRun(row) : undefined
  }

  skillSources(): SkillSource[] {
    return this.db.query<SkillSourceRow, []>("SELECT * FROM skill_sources ORDER BY created_at, id").all().map(toSkillSource)
  }

  skillSource(id: string): SkillSource | undefined {
    const row = this.db.query<SkillSourceRow, [string]>("SELECT * FROM skill_sources WHERE id = ?").get(id)
    return row ? toSkillSource(row) : undefined
  }

  createSkillSource(s: Pick<SkillSource, "id" | "repo" | "ref" | "installationId">, now = Date.now()): SkillSource {
    this.db
      .query("INSERT INTO skill_sources (id, repo, ref, installation_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(s.id, s.repo, s.ref, s.installationId, now)
    return this.skillSource(s.id)!
  }

  updateSkillSource(id: string, patch: SkillSourcePatch): SkillSource | undefined {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof SkillSourcePatch, string | number | null][]
    if (entries.length) {
      const sets = entries.map(([k]) => `${SKILL_SOURCE_COLUMNS[k]} = ?`).join(", ")
      this.db.query(`UPDATE skill_sources SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => v), id)
    }
    return this.skillSource(id)
  }

  deleteSkillSource(id: string): void {
    this.db.query("DELETE FROM skill_sources WHERE id = ?").run(id)
  }

  /** Skills switched on or off in the admin UI, as `sourceId/skillId`. A skill without a row is enabled. */
  skillStates(): Map<string, boolean> {
    const rows = this.db.query<{ source_id: string; skill_id: string; enabled: number }, []>("SELECT * FROM skill_states").all()
    return new Map(rows.map((r) => [`${r.source_id}/${r.skill_id}`, r.enabled === 1]))
  }

  setSkillEnabled(sourceId: string, skillId: string, enabled: boolean): void {
    this.db
      .query(
        `INSERT INTO skill_states (source_id, skill_id, enabled) VALUES (?, ?, ?)
         ON CONFLICT(source_id, skill_id) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(sourceId, skillId, enabled ? 1 : 0)
  }

  personas(): Persona[] {
    return this.db.query<PersonaRow, []>("SELECT * FROM personas ORDER BY name COLLATE NOCASE").all().map(toPersona)
  }

  persona(id: number): Persona | undefined {
    const row = this.db.query<PersonaRow, [number]>("SELECT * FROM personas WHERE id = ?").get(id)
    return row ? toPersona(row) : undefined
  }

  createPersona(name: string, prompt: string, now = Date.now()): Persona {
    const { id } = this.db
      .query<{ id: number }, [string, string, number, number]>("INSERT INTO personas (name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id")
      .get(name, prompt, now, now)!
    return this.persona(id)!
  }

  updatePersona(id: number, patch: Partial<Pick<Persona, "name" | "prompt">>, now = Date.now()): Persona | undefined {
    const current = this.persona(id)
    if (!current) return undefined
    this.db
      .query("UPDATE personas SET name = ?, prompt = ?, updated_at = ? WHERE id = ?")
      .run(patch.name ?? current.name, patch.prompt ?? current.prompt, now, id)
    return this.persona(id)
  }

  deletePersona(id: number): void {
    this.db.query("DELETE FROM personas WHERE id = ?").run(id)
  }

  people(): Person[] {
    return this.db.query<PersonRow, []>("SELECT * FROM people ORDER BY seen_at DESC NULLS LAST, user_id").all().map(toPerson)
  }

  person(id: number): Person | undefined {
    const row = this.db.query<PersonRow, [number]>("SELECT * FROM people WHERE user_id = ?").get(id)
    return row ? toPerson(row) : undefined
  }

  /** Record that a Telegram user sent a message, keeping their display name current. Returns their person ID. */
  seePerson(telegramId: number, name: string | null, username: string | null, now = Date.now()): number {
    const linked = this.db.query<{ user_id: number }, [number]>("SELECT user_id FROM people WHERE telegram_id = ?").get(telegramId)
    if (linked) {
      this.db.query("UPDATE people SET name = ?, username = ?, seen_at = ? WHERE user_id = ?").run(name, username, now, linked.user_id)
      return linked.user_id
    }
    this.db
      .query(
        `INSERT INTO people (user_id, telegram_id, name, username, seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET telegram_id = excluded.telegram_id, name = excluded.name, username = excluded.username, seen_at = excluded.seen_at`,
      )
      .run(telegramId, telegramId, name, username, now)
    return telegramId
  }

  personByTelegram(telegramId: number): Person | undefined {
    const row = this.db.query<PersonRow, [number]>("SELECT * FROM people WHERE telegram_id = ?").get(telegramId)
    return row ? toPerson(row) : undefined
  }

  /** Someone who starts in the app, without Telegram. Their app-only chat shares their ID. */
  createAppPerson(name: string | null): Person {
    const id = this.nextAppId()
    this.db.query("INSERT INTO people (user_id, app_chat_id, name) VALUES (?, ?, ?)").run(id, id, name)
    return this.person(id)!
  }

  /** The chat a person's app-only conversations live in, created on first use. */
  appChatOf(personId: number): number {
    const person = this.person(personId)
    if (!person) throw new Error(`No person ${personId}`)
    if (person.appChatId !== null) return person.appChatId
    const chatId = this.nextAppId()
    this.db.query("UPDATE people SET app_chat_id = ? WHERE user_id = ?").run(chatId, personId)
    return chatId
  }

  private nextAppId(): number {
    const row = this.db
      .query<{ top: number | null }, [number, number]>(
        "SELECT MAX(v) AS top FROM (SELECT user_id AS v FROM people WHERE user_id >= ? UNION ALL SELECT app_chat_id FROM people WHERE app_chat_id >= ?)",
      )
      .get(APP_ID_BASE, APP_ID_BASE)
    return row?.top ? row.top + 1 : APP_ID_BASE
  }

  /** The person a private chat belongs to: an app-only chat's owner, or the Telegram user. Groups have none. */
  ownerOfChat(chatId: number): number | null {
    if (isAppChat(chatId)) return this.db.query<{ user_id: number }, [number]>("SELECT user_id FROM people WHERE app_chat_id = ?").get(chatId)?.user_id ?? null
    if (chatId <= 0) return null
    return this.db.query<{ user_id: number }, [number]>("SELECT user_id FROM people WHERE telegram_id = ?").get(chatId)?.user_id ?? chatId
  }

  /**
   * A person's private conversations, in Telegram and in the app: pinned ones first, then most recent first.
   * Groups are left out. `archived` picks the archived ones, or `"all"` both.
   */
  conversationsOf(personId: number, limit = 100, archived: boolean | "all" = false): ChatState[] {
    const person = this.person(personId)
    const chats = [person?.telegramId ?? null, person?.appChatId ?? null].filter((c): c is number => c !== null)
    if (!chats.length) return []
    const filter = archived === "all" ? "" : archived ? " AND archived_at IS NOT NULL" : " AND archived_at IS NULL"
    const order = archived === true ? "archived_at DESC" : "pinned DESC, updated_at DESC"
    return this.db
      .query<Row, number[]>(`SELECT * FROM threads WHERE chat_id IN (${chats.map(() => "?").join(", ")})${filter} ORDER BY ${order} LIMIT ?`)
      .all(...chats, limit)
      .map(toState)
  }

  /** The next free thread number in an app-only chat. */
  nextAppThread(chatId: number): number {
    const row = this.db.query<{ top: number | null }, [number]>("SELECT MAX(thread_id) AS top FROM threads WHERE chat_id = ?").get(chatId)
    return (row?.top ?? 0) + 1
  }

  addInvite(codeHash: string, personId: number, expiresAt: number, now = Date.now()): void {
    this.db.query("INSERT INTO app_invites (code_hash, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(codeHash, personId, now, expiresAt)
  }

  /** Use up an invite. Returns whose it was, or undefined when it's unknown, used or expired. */
  takeInvite(codeHash: string, now = Date.now()): number | undefined {
    return (
      this.db
        .query<{ person_id: number }, [number, string, number]>(
          "UPDATE app_invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING person_id",
        )
        .get(now, codeHash, now)?.person_id ?? undefined
    )
  }

  /** Invites that can still be used, per person. */
  openInvites(now = Date.now()): Map<number, number> {
    const rows = this.db
      .query<{ person_id: number; n: number }, [number]>("SELECT person_id, COUNT(*) AS n FROM app_invites WHERE used_at IS NULL AND expires_at > ? GROUP BY person_id")
      .all(now)
    return new Map(rows.map((r) => [r.person_id, r.n]))
  }

  addDevice(d: { id: string; personId: number; tokenHash: string; name: string | null; platform: string | null }, now = Date.now()): AppDevice {
    this.db
      .query("INSERT INTO app_devices (id, person_id, token_hash, name, platform, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(d.id, d.personId, d.tokenHash, d.name, d.platform, now, now)
    return this.device(d.id)!
  }

  device(id: string): AppDevice | undefined {
    const row = this.db.query<DeviceRow, [string]>("SELECT * FROM app_devices WHERE id = ?").get(id)
    return row ? toDevice(row) : undefined
  }

  deviceByToken(tokenHash: string): AppDevice | undefined {
    const row = this.db.query<DeviceRow, [string]>("SELECT * FROM app_devices WHERE token_hash = ?").get(tokenHash)
    return row ? toDevice(row) : undefined
  }

  devicesOf(personId: number): AppDevice[] {
    return this.db.query<DeviceRow, [number]>("SELECT * FROM app_devices WHERE person_id = ? ORDER BY created_at").all(personId).map(toDevice)
  }

  touchDevice(id: string, now = Date.now()): void {
    this.db.query("UPDATE app_devices SET seen_at = ? WHERE id = ?").run(now, id)
  }

  setPushToken(id: string, token: string | null): void {
    // A token belongs to one installation; if another device row had it, that sign-in is stale.
    if (token) this.db.query("UPDATE app_devices SET push_token = NULL WHERE push_token = ? AND id != ?").run(token, id)
    this.db.query("UPDATE app_devices SET push_token = ? WHERE id = ?").run(token, id)
  }

  /** Expo said the token is no longer valid. */
  dropPushToken(token: string): void {
    this.db.query("UPDATE app_devices SET push_token = NULL WHERE push_token = ?").run(token)
  }

  deleteDevice(id: string): void {
    this.db.query("DELETE FROM app_devices WHERE id = ?").run(id)
  }

  updatePerson(id: number, patch: Partial<Pick<Person, "personaId" | "memoryMode" | "spendDaily" | "spendMonthly" | "spendExempt">>): Person {
    this.db.query("INSERT OR IGNORE INTO people (user_id, telegram_id) VALUES (?, ?)").run(id, id < APP_ID_BASE ? id : null)
    if (patch.personaId !== undefined) this.db.query("UPDATE people SET persona_id = ? WHERE user_id = ?").run(patch.personaId, id)
    if (patch.memoryMode !== undefined) this.db.query("UPDATE people SET memory_mode = ? WHERE user_id = ?").run(patch.memoryMode, id)
    if (patch.spendDaily !== undefined) this.db.query("UPDATE people SET spend_daily = ? WHERE user_id = ?").run(patch.spendDaily, id)
    if (patch.spendMonthly !== undefined) this.db.query("UPDATE people SET spend_monthly = ? WHERE user_id = ?").run(patch.spendMonthly, id)
    if (patch.spendExempt !== undefined) this.db.query("UPDATE people SET spend_exempt = ? WHERE user_id = ?").run(patch.spendExempt ? 1 : 0, id)
    return this.person(id)!
  }

  memories(userId: number): Memory[] {
    return this.db.query<MemoryRow, [number]>("SELECT * FROM memories WHERE user_id = ? ORDER BY id").all(userId).map(toMemory)
  }

  memory(id: number): Memory | undefined {
    const row = this.db.query<MemoryRow, [number]>("SELECT * FROM memories WHERE id = ?").get(id)
    return row ? toMemory(row) : undefined
  }

  addMemory(userId: number, text: string, source: Memory["source"], now = Date.now()): Memory {
    const { id } = this.db
      .query<{ id: number }, [number, string, string, number, number]>(
        "INSERT INTO memories (user_id, text, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
      .get(userId, text, source, now, now)!
    return this.memory(id)!
  }

  updateMemory(id: number, text: string, now = Date.now()): Memory | undefined {
    this.db.query("UPDATE memories SET text = ?, updated_at = ? WHERE id = ?").run(text, now, id)
    return this.memory(id)
  }

  deleteMemory(id: number): void {
    this.db.query("DELETE FROM memories WHERE id = ?").run(id)
  }

  /** Forget everything about a user. Returns how many memories were removed. */
  clearMemories(userId: number): number {
    return this.db.query("DELETE FROM memories WHERE user_id = ?").run(userId).changes
  }

  /** Runs left "running" by a previous process that stopped mid-run. */
  abandonRuns(now = Date.now()): void {
    this.db
      .query("UPDATE schedule_runs SET status = 'failed', error = 'The bot stopped during this run.', ended_at = ? WHERE status = 'running'")
      .run(now)
  }

  close(): void {
    this.db.close()
  }
}

type Row = {
  chat_id: number
  thread_id: number
  session_id: string
  auto_title: number
  updated_at: number
  user_id: number | null
  pinned?: number
  archived_at?: number | null
}

function toState(row: Row): ChatState {
  return {
    chatId: row.chat_id,
    threadId: row.thread_id,
    sessionID: row.session_id,
    userId: row.user_id ?? null,
    autoTitle: row.auto_title === 1,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
    archivedAt: row.archived_at ?? null,
  }
}

type ScheduleRow = {
  id: number
  chat_id: number | null
  name: string
  kind: ScheduleKind
  spec: string
  type: TaskType
  prompt: string
  command: string | null
  model: string | null
  agent: string | null
  silent: number
  paused: number
  fail_streak: number
  next_at: number | null
  created_by: "user" | "agent"
  created_at: number
}

function schedulesTable(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    spec TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'prompt',
    prompt TEXT NOT NULL,
    command TEXT,
    model TEXT,
    agent TEXT,
    silent INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    fail_streak INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    created_by TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL
  )`
}

function toSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    chatId: r.chat_id,
    name: r.name,
    kind: r.kind,
    spec: r.spec,
    type: r.type,
    prompt: r.prompt,
    command: r.command,
    model: r.model,
    agent: r.agent,
    silent: r.silent === 1,
    paused: r.paused === 1,
    failStreak: r.fail_streak,
    nextAt: r.next_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }
}

type SkillSourceRow = {
  id: string
  repo: string
  ref: string | null
  installation_id: number | null
  last_sync_at: number | null
  last_commit: string | null
  last_error: string | null
  fail_streak: number
  created_at: number
}

function toSkillSource(r: SkillSourceRow): SkillSource {
  return {
    id: r.id,
    repo: r.repo,
    ref: r.ref,
    installationId: r.installation_id,
    lastSyncAt: r.last_sync_at,
    lastCommit: r.last_commit,
    lastError: r.last_error,
    failStreak: r.fail_streak,
    createdAt: r.created_at,
  }
}

type RunRow = {
  id: number
  schedule_id: number
  session_id: string | null
  started_at: number
  ended_at: number | null
  status: RunStatus
  error: string | null
  output: string | null
}

function toRun(r: RunRow): ScheduleRun {
  return {
    id: r.id,
    scheduleId: r.schedule_id,
    sessionID: r.session_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    error: r.error,
    output: r.output,
  }
}

type PersonaRow = { id: number; name: string; prompt: string; created_at: number; updated_at: number }

function toPersona(r: PersonaRow): Persona {
  return { id: r.id, name: r.name, prompt: r.prompt, createdAt: r.created_at, updatedAt: r.updated_at }
}

type DeviceRow = {
  id: string
  person_id: number
  token_hash: string
  name: string | null
  platform: string | null
  push_token: string | null
  created_at: number
  seen_at: number | null
}

function toDevice(r: DeviceRow): AppDevice {
  return { id: r.id, personId: r.person_id, name: r.name, platform: r.platform, pushToken: r.push_token, createdAt: r.created_at, seenAt: r.seen_at }
}

type PersonRow = {
  user_id: number
  telegram_id: number | null
  app_chat_id: number | null
  name: string | null
  username: string | null
  persona_id: number | null
  memory_mode: string | null
  seen_at: number | null
  spend_daily: number | null
  spend_monthly: number | null
  spend_exempt: number
}

function toPerson(r: PersonRow): Person {
  const mode = MEMORY_MODES.find((m) => m === r.memory_mode) ?? null
  return {
    id: r.user_id,
    telegramId: r.telegram_id ?? null,
    appChatId: r.app_chat_id ?? null,
    name: r.name,
    username: r.username,
    personaId: r.persona_id,
    memoryMode: mode,
    seenAt: r.seen_at,
    spendDaily: r.spend_daily,
    spendMonthly: r.spend_monthly,
    spendExempt: r.spend_exempt === 1,
  }
}

type MemoryRow = { id: number; user_id: number; text: string; source: Memory["source"]; created_at: number; updated_at: number }

function toMemory(r: MemoryRow): Memory {
  return { id: r.id, userId: r.user_id, text: r.text, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at }
}
