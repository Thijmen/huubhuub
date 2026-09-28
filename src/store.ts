import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

/** A conversation surface: a Telegram chat, optionally narrowed to one forum topic (thread). */
export interface ChatKey {
  chatId: number
  /** 0 when the chat has no topics or the message is outside a topic. */
  threadId: number
}

export interface ChatState extends ChatKey {
  sessionID: string
  /** The bot created this topic, so it may rename it after the session title. */
  autoTitle: boolean
  updatedAt: number
}

export interface McpRecord {
  name: string
  /** `null` marks a server from bot.opencode.jsonc that was removed in the admin UI. */
  config: Record<string, unknown> | null
}

export type ScheduleKind = "cron" | "interval" | "once"
export type RunStatus = "running" | "ok" | "failed" | "silent" | "skipped" | "missed"

export interface Schedule {
  id: number
  chatId: number
  name: string
  kind: ScheduleKind
  /** A cron expression or nickname, `every 30m`, or the ISO time of a one-off job. */
  spec: string
  prompt: string
  /** `provider/model`, or null for the default. */
  model: string | null
  agent: string | null
  silent: boolean
  paused: boolean
  failStreak: number
  /** Epoch ms of the next run; null once a one-off job has fired. */
  nextAt: number | null
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
}

export type NewSchedule = Pick<Schedule, "chatId" | "name" | "kind" | "spec" | "prompt" | "model" | "agent" | "silent" | "nextAt">
export type SchedulePatch = Partial<Omit<Schedule, "id" | "chatId" | "createdAt">>

const SCHEDULE_COLUMNS: Record<keyof SchedulePatch, string> = {
  name: "name",
  kind: "kind",
  spec: "spec",
  prompt: "prompt",
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
    this.db.run(`CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      spec TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT,
      agent TEXT,
      silent INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      fail_streak INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER,
      created_at INTEGER NOT NULL
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      session_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      error TEXT
    )`)
    this.db.run("CREATE INDEX IF NOT EXISTS schedule_runs_by_schedule ON schedule_runs (schedule_id, started_at DESC)")
    this.db.run("PRAGMA foreign_keys = ON")
    this.migrateChats()
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

  touch(key: ChatKey): void {
    this.db
      .query("UPDATE threads SET updated_at = ? WHERE chat_id = ? AND thread_id = ?")
      .run(Date.now(), key.chatId, key.threadId)
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

  schedules(chatId?: number): Schedule[] {
    const rows =
      chatId === undefined
        ? this.db.query<ScheduleRow, []>("SELECT * FROM schedules ORDER BY chat_id, id").all()
        : this.db.query<ScheduleRow, [number]>("SELECT * FROM schedules WHERE chat_id = ? ORDER BY id").all(chatId)
    return rows.map(toSchedule)
  }

  schedule(id: number): Schedule | undefined {
    const row = this.db.query<ScheduleRow, [number]>("SELECT * FROM schedules WHERE id = ?").get(id)
    return row ? toSchedule(row) : undefined
  }

  createSchedule(s: NewSchedule, now = Date.now()): Schedule {
    const { id } = this.db
      .query<{ id: number }, [number, string, string, string, string, string | null, string | null, number, number | null, number]>(
        `INSERT INTO schedules (chat_id, name, kind, spec, prompt, model, agent, silent, next_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(s.chatId, s.name, s.kind, s.spec, s.prompt, s.model, s.agent, s.silent ? 1 : 0, s.nextAt, now)!
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

  finishRun(runId: number, status: RunStatus, error: string | null = null, endedAt = Date.now()): void {
    this.db.query("UPDATE schedule_runs SET status = ?, error = ?, ended_at = ? WHERE id = ?").run(status, error, endedAt, runId)
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

type Row = { chat_id: number; thread_id: number; session_id: string; auto_title: number; updated_at: number }

function toState(row: Row): ChatState {
  return {
    chatId: row.chat_id,
    threadId: row.thread_id,
    sessionID: row.session_id,
    autoTitle: row.auto_title === 1,
    updatedAt: row.updated_at,
  }
}

type ScheduleRow = {
  id: number
  chat_id: number
  name: string
  kind: ScheduleKind
  spec: string
  prompt: string
  model: string | null
  agent: string | null
  silent: number
  paused: number
  fail_streak: number
  next_at: number | null
  created_at: number
}

function toSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    chatId: r.chat_id,
    name: r.name,
    kind: r.kind,
    spec: r.spec,
    prompt: r.prompt,
    model: r.model,
    agent: r.agent,
    silent: r.silent === 1,
    paused: r.paused === 1,
    failStreak: r.fail_streak,
    nextAt: r.next_at,
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
  }
}
