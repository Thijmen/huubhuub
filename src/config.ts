import { z } from "zod"

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_USER_IDS: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .map(Number),
    )
    .pipe(z.array(z.number().int().positive()).min(1)),
  WORKSPACE_DIR: z.string().default("/workspace"),
  DATA_DIR: z.string().default("/data"),
  DEFAULT_MODEL: z.string().optional(),
  DEFAULT_AGENT: z.string().optional(),
  OPENCODE_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("warn"),
  TRANSCRIBE_REGION: z.string().optional(),
  TRANSCRIBE_LANGUAGE: z.string().optional(),
  TRANSCRIBE_LANGUAGE_OPTIONS: z.string().default("en-US,nl-NL"),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
    throw new Error(`Invalid configuration:\n${issues}`)
  }
  return parsed.data
}

export function parseModelRef(ref: string): { providerID: string; id: string } {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`Invalid model "${ref}", expected provider/model`)
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }
}
