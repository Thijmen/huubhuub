import { autoRetry } from "@grammyjs/auto-retry"
import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { startAdmin } from "./admin/server"
import { AgentSchedules } from "./agent-schedules"
import { createBot } from "./bot"
import { Chats } from "./chats"
import { loadConfig } from "./config"
import { GitHubAccess } from "./github-access"
import { GitHubApp } from "./github-app"
import { InternalApi } from "./internal"
import { Bridge } from "./opencode"
import { Questions, trackForms } from "./question"
import { scheduleCommands } from "./schedule-commands"
import { ScheduleRunner } from "./schedule-runner"
import { ScheduleService } from "./schedule-service"
import { Scheduler } from "./scheduler"
import { Settings } from "./settings"
import { skillCommands } from "./skill-commands"
import { SkillSources } from "./skills"
import { Store } from "./store"
import { Transcriber } from "./transcribe"

const config = loadConfig()
mkdirSync(config.WORKSPACE_DIR, { recursive: true })

const store = new Store(config.DATA_DIR)
const settings = new Settings(config, store)
settings.load()

// The agent's processes reach back to the bot through this; it has to exist before OpenCode starts.
const internal = new InternalApi()

// Pull skill repos before OpenCode starts so the first sessions already see them. Alerts wait for the bot.
const github = new GitHubApp(store)
const githubAccess = new GitHubAccess(github, store, config.DATA_DIR)
await githubAccess.writeGitConfig()
const agentEnv = () => internal.env(githubAccess.gitConfig)
const skills = new SkillSources(store, config.DATA_DIR, () => config.SKILL_SYNC_INTERVAL_MINUTES, github)
const bootAlerts: string[] = []
skills.onAlert = (html) => bootAlerts.push(html)
if (store.skillSources().length) {
  console.log(`Syncing ${store.skillSources().length} skill source(s)…`)
  await skills.sync()
}

console.log(`Starting OpenCode (workspace ${config.WORKSPACE_DIR})…`)
const bridge = await Bridge.start(config, store, { skillDirs: [skills.enabledDir], pluginDirs: [join(import.meta.dir, "agent-plugin")], env: agentEnv })

const transcriber = Transcriber.enabled() ? new Transcriber(config) : undefined
if (!transcriber) console.warn("No AWS credentials found; voice transcription is disabled.")

const questions = new Questions(
  { reply: (sessionID, formID, answer) => bridge.replyForm(sessionID, formID, answer) },
  () => config.QUESTION_TIMEOUT_MINUTES,
)
bridge.subscribeAll((e) => trackForms(questions, e))

const timeZone = () => config.SCHEDULE_TIMEZONE
/** Scheduled commands get the agent's environment, plus a GitHub token for `gh` (git asks the credential helper). */
const commandEnv = async (): Promise<Record<string, string | undefined>> => {
  const env: Record<string, string | undefined> = { ...process.env, ...agentEnv() }
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) {
    const token = await githubAccess.token({ cwd: config.WORKSPACE_DIR }).catch((err) => console.error("Couldn't get a GitHub token for a scheduled command", err))
    if (token) env.GH_TOKEN = token
  }
  return env
}
let chats!: Chats
let scheduler!: Scheduler
const bot = createBot(
  config,
  bridge,
  (b) => {
    chats = new Chats(b.api, bridge, store, config, transcriber, () => (b.isInited() ? b.botInfo : undefined), questions)
    const runner = new ScheduleRunner({
      api: b.api,
      bridge,
      chats,
      questions,
      timeZone,
      allowedUsers: () => config.ALLOWED_USER_IDS,
      workspace: config.WORKSPACE_DIR,
      commandEnv,
    })
    scheduler = new Scheduler(store, runner, timeZone)
    return chats
  },
  (b, c) => {
    scheduleCommands({ bridge, store, scheduler, timeZone })(b, c)
    skillCommands({ skills, timeZone })(b)
  },
)
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }))
const schedules = new ScheduleService(store, scheduler, bridge, timeZone)
internal.attach({ github: githubAccess, schedules: new AgentSchedules(store, schedules, scheduler, bridge, timeZone) })

skills.onAlert = (html) => {
  for (const id of config.ALLOWED_USER_IDS) {
    bot.api.sendMessage(id, html, { parse_mode: "HTML" }).catch((err) => console.error(`Couldn't send the skill sync alert to ${id}`, err))
  }
}
for (const html of bootAlerts.splice(0)) skills.onAlert(html)

await bot.api.setMyCommands([
  { command: "new", description: "Start a new conversation thread" },
  { command: "stop", description: "Interrupt the current run" },
  { command: "model", description: "Switch model" },
  { command: "agent", description: "Switch agent" },
  { command: "status", description: "Session info" },
  { command: "schedule", description: "Run a prompt or command on a schedule" },
  { command: "schedules", description: "Manage scheduled tasks" },
  { command: "skills", description: "List loaded skills" },
  { command: "help", description: "Show help" },
])

scheduler.start()
skills.start()
console.log(`Scheduler running (${store.schedules().length} jobs, time zone ${config.SCHEDULE_TIMEZONE})`)

const admin = startAdmin({ config, bridge, store, settings, bot, chats, scheduler, schedules, skills, github, githubAccess, token: adminToken() })
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
  internal.stop()
  scheduler.stop()
  skills.stop()
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
        allowed_updates: ["message", "callback_query", "stopped_message_generation"],
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
