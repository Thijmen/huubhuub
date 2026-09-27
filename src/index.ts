import { autoRetry } from "@grammyjs/auto-retry"
import { mkdirSync } from "node:fs"
import { createBot } from "./bot"
import { Chats } from "./chats"
import { loadConfig } from "./config"
import { Bridge } from "./opencode"
import { Store } from "./store"
import { Transcriber } from "./transcribe"

const config = loadConfig()
mkdirSync(config.WORKSPACE_DIR, { recursive: true })

const store = new Store(config.DATA_DIR)
console.log(`Starting OpenCode (workspace ${config.WORKSPACE_DIR})…`)
const bridge = await Bridge.start(config, store)

const transcriber = Transcriber.enabled() ? new Transcriber(config) : undefined
if (!transcriber) console.warn("No AWS credentials found; voice transcription is disabled.")

const bot = createBot(config, bridge, (b) => new Chats(b.api, bridge, store, config, transcriber))
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }))

await bot.api.setMyCommands([
  { command: "new", description: "Start a fresh session" },
  { command: "stop", description: "Interrupt the current run" },
  { command: "model", description: "Switch model" },
  { command: "agent", description: "Switch agent" },
  { command: "status", description: "Session info" },
  { command: "help", description: "Show help" },
])

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`${signal} received, shutting down…`)
  await bot.stop().catch(() => {})
  await bridge.close().catch((err) => console.error("OpenCode close failed", err))
  store.close()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))

async function poll(): Promise<void> {
  while (!stopping) {
    try {
      await bot.start({
        drop_pending_updates: false,
        allowed_updates: ["message", "callback_query"],
        onStart: (me) => console.log(`Bot @${me.username} is running. Allowed users: ${config.ALLOWED_USER_IDS.join(", ")}`),
      })
      return
    } catch (err) {
      if (stopping) return
      const conflict = String(err).includes("409")
      console.error(conflict ? "Another instance is polling this bot token; retrying in 10s" : "Polling failed; retrying in 5s", err)
      await Bun.sleep(conflict ? 10_000 : 5_000)
    }
  }
}

await poll()
