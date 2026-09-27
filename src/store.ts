import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

export interface ChatState {
  chatId: number
  sessionID: string
}

export class Store {
  private db: Database

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new Database(join(dataDir, "bot.sqlite"), { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run(`CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
  }

  get(chatId: number): ChatState | undefined {
    const row = this.db
      .query<{ chat_id: number; session_id: string }, [number]>(
        "SELECT chat_id, session_id FROM chats WHERE chat_id = ?",
      )
      .get(chatId)
    return row ? { chatId: row.chat_id, sessionID: row.session_id } : undefined
  }

  set(chatId: number, sessionID: string): void {
    this.db
      .query(
        `INSERT INTO chats (chat_id, session_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(chatId, sessionID, Date.now())
  }

  delete(chatId: number): void {
    this.db.query("DELETE FROM chats WHERE chat_id = ?").run(chatId)
  }

  close(): void {
    this.db.close()
  }
}
