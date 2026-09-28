import { autoRetry } from "@grammyjs/auto-retry"
import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { startAdmin } from "./admin/server"
import { createBot } from "./bot"
import { Chats } from "./chats"
import { loadConfig } from "./config"
import { Bridge } from "./opencode"
import { Questions, trackForms } from "./question"
import { Settings } from "./settings"
import { Store } from "./store"
import { Transcriber } from "./transcribe"

const config = loadConfig()
mkdirSync(config.WORKSPACE_DIR, { recursive: true })

const store = new Store(config.DATA_DIR)
const settings = new Settings(config, store)
settings.load()

console.log(`Starting OpenCode (workspace ${config.WORKSPACE_DIR})…`)
const bridge = await Bridge.start(config, store)

const transcriber = Transcriber.enabled() ? new Transcriber(config) : undefined
if (!transcriber) console.warn("No AWS credentials found; voice transcription is disabled.")

const questions = new Questions(
  { reply: (sessionID, formID, answer) => bridge.replyForm(sessionID, formID, answer) },
  () => config.QUESTION_TIMEOUT_MINUTES,
)
bridge.subscribeAll((e) => trackForms(questions, e))

let chats!: Chats
const bot = createBot(
  config,
  bridge,
  (b) => (chats = new Chats(b.api, bridge, store, config, transcriber, () => (b.isInited() ? b.botInfo : undefined), questions)),
)
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }))

await bot.api.setMyCommands([
  { command: "new", description: "Start a new conversation thread" },
  { command: "stop", description: "Interrupt the current run" },
  { command: "model", description: "Switch model" },
  { command: "agent", description: "Switch agent" },
  { command: "status", description: "Session info" },
  { command: "help", description: "Show help" },
])

const admin = startAdmin({ config, bridge, store, settings, bot, chats, token: adminToken() })
console.log(`Admin UI on ${config.ADMIN_PUBLIC_URL ?? `http://localhost:${admin.port}`}`)

function adminToken(): string {
  if (config.ADMIN_TOKEN) return config.ADMIN_TOKEN
  let token = store.getSetting("admin_token")
  if (!token) {
    token = randomBytes(24).toString("base64url")
    store.setSetting("admin_token", token)
  }
  console.log(`ADMIN_TOKEN is not set; sign in to the admin UI with: ${token}`)
  return token
}

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`${signal} received, shutting down…`)
  admin.stop(true)
  questions.dispose()
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
        onStart: (me) => {
          const users = config.ALLOWED_USER_IDS.length ? config.ALLOWED_USER_IDS.join(", ") : "none (add some in the admin UI)"
          const threads = config.THREAD_MODE === "off" ? "off" : me.has_topics_enabled ? "on" : "groups only (enable Threaded Mode in @BotFather for private chats)"
          console.log(`Bot @${me.username} is running. Allowed users: ${users}. Threads: ${threads}`)
        },
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
