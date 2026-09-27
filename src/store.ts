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
  /** `null` marks a server from opencode.jsonc that was removed in the admin UI. */
  config: Record<string, unknown> | null
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
