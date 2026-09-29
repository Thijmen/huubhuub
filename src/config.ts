import { resolve } from "node:path"
import { z } from "zod"
import { isTimeZone, serverTimeZone } from "./schedule-spec"

/** `/workspace` and `/data` in the container; `./workspace` and `./data` when running locally. */
function defaultDir(name: string): string {
  return process.env.NODE_ENV === "production" ? `/${name}` : `./${name}`
}

const userIds = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map(Number),
  )
  .pipe(z.array(z.number().int().positive()))

const DEFAULT_QUESTION_TIMEOUT = 10
const DEFAULT_SKILL_SYNC_INTERVAL = 60

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_USER_IDS: userIds,
  WORKSPACE_DIR: z.string().default(defaultDir("workspace")).transform((p) => resolve(p)),
  DATA_DIR: z.string().default(defaultDir("data")).transform((p) => resolve(p)),
  DEFAULT_MODEL: z.string().optional(),
  DEFAULT_AGENT: z.string().optional(),
  THREAD_MODE: z.enum(["auto", "off"]).default("auto"),
  TELEGRAM_STREAMING: z.enum(["draft", "edit"]).default("draft"),
  OPENCODE_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("warn"),
  TRANSCRIBE_REGION: z.string().optional(),
  TRANSCRIBE_LANGUAGE: z.string().optional(),
  TRANSCRIBE_LANGUAGE_OPTIONS: z.string().default("en-US,nl-NL"),
  ADMIN_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  ADMIN_HOST: z.string().default("0.0.0.0"),
  ADMIN_TOKEN: z.string().optional(),
  ADMIN_PUBLIC_URL: z.string().url().optional(),
  QUESTION_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(DEFAULT_QUESTION_TIMEOUT),
  SCHEDULE_TIMEZONE: z
    .string()
    .default(() => serverTimeZone())
    .refine(isTimeZone, "must be an IANA time zone such as Europe/Amsterdam"),
  SKILL_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(DEFAULT_SKILL_SYNC_INTERVAL),
})

export type Config = z.infer<typeof schema>

/** Settings the admin UI can change at runtime. They are stored in SQLite and override the environment. */
export const RUNTIME_SETTINGS = ["DEFAULT_MODEL", "DEFAULT_AGENT", "ALLOWED_USER_IDS", "THREAD_MODE", "TELEGRAM_STREAMING", "QUESTION_TIMEOUT_MINUTES", "SCHEDULE_TIMEZONE", "SKILL_SYNC_INTERVAL_MINUTES"] as const
export type RuntimeSetting = (typeof RUNTIME_SETTINGS)[number]

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""))
  const parsed = schema.safeParse(cleaned)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
    throw new Error(`Invalid configuration:\n${issues}`)
  }
  return parsed.data
}

/** Validate one runtime setting and write it into the live config. `undefined` restores the environment value. */
export function applySetting(config: Config, key: RuntimeSetting, value: string | undefined, env = process.env): void {
  const raw = value ?? env[key] ?? ""
  switch (key) {
    case "ALLOWED_USER_IDS": {
      const parsed = userIds.safeParse(raw)
      if (!parsed.success) throw new Error("Allowed users must be numeric Telegram user IDs separated by commas.")
      config.ALLOWED_USER_IDS = parsed.data
      break
    }
    case "THREAD_MODE":
      if (raw && raw !== "auto" && raw !== "off") throw new Error('Thread mode must be "auto" or "off".')
      config.THREAD_MODE = raw === "off" ? "off" : "auto"
      break
    case "TELEGRAM_STREAMING":
      if (raw && raw !== "draft" && raw !== "edit") throw new Error('Streaming must be "draft" or "edit".')
      config.TELEGRAM_STREAMING = raw === "edit" ? "edit" : "draft"
      break
    case "DEFAULT_MODEL":
      if (raw) parseModelRef(raw)
      config.DEFAULT_MODEL = raw || undefined
      break
    case "DEFAULT_AGENT":
      config.DEFAULT_AGENT = raw || undefined
      break
    case "QUESTION_TIMEOUT_MINUTES": {
      const minutes = raw ? Number(raw) : DEFAULT_QUESTION_TIMEOUT
      if (!Number.isInteger(minutes) || minutes <= 0) throw new Error("Question timeout must be a whole number of minutes above 0.")
      config.QUESTION_TIMEOUT_MINUTES = minutes
      break
    }
    case "SCHEDULE_TIMEZONE": {
      const tz = raw.trim() || serverTimeZone()
      if (!isTimeZone(tz)) throw new Error(`"${tz}" isn't a time zone. Use an IANA name such as Europe/Amsterdam.`)
      config.SCHEDULE_TIMEZONE = tz
      break
    }
    case "SKILL_SYNC_INTERVAL_MINUTES": {
      const minutes = raw ? Number(raw) : DEFAULT_SKILL_SYNC_INTERVAL
      if (!Number.isInteger(minutes) || minutes < 0) throw new Error("Skill sync interval must be a whole number of minutes (0 turns it off).")
      config.SKILL_SYNC_INTERVAL_MINUTES = minutes
      break
    }
  }
}

export function parseModelRef(ref: string): { providerID: string; id: string } {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`Invalid model "${ref}", expected provider/model`)
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }
}
