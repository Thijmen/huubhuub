export interface EnvEntry {
  name: string
  value: string
  /** The name was inferred from the key's prefix rather than given explicitly. */
  guessed?: boolean
}

export interface IntegrationLike {
  id: string
  name: string
  methods: ReadonlyArray<{ type: string; names?: ReadonlyArray<string> }>
}

export interface EnvPlan {
  name: string
  masked: string
  guessed: boolean
  /** "credential" stores the key in OpenCode's credential store; "env" keeps it as a managed environment variable. */
  action: "credential" | "env"
  integration?: { id: string; name: string }
}

const KEY_PREFIXES: ReadonlyArray<[prefix: string, name: string]> = [
  ["sk-ant-", "ANTHROPIC_API_KEY"],
  ["sk-or-", "OPENROUTER_API_KEY"],
  ["sk-proj-", "OPENAI_API_KEY"],
  ["sk-svcacct-", "OPENAI_API_KEY"],
  ["AIza", "GOOGLE_GENERATIVE_AI_API_KEY"],
  ["gsk_", "GROQ_API_KEY"],
  ["xai-", "XAI_API_KEY"],
  ["pplx-", "PERPLEXITY_API_KEY"],
  ["github_pat_", "GITHUB_TOKEN"],
  ["ghp_", "GITHUB_TOKEN"],
]

/** Parse pasted dotenv-style lines, a JSON object, or bare API keys with a recognisable prefix. */
export function parseEnvText(text: string): { entries: EnvEntry[]; errors: string[] } {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      const entries = Object.entries(obj)
        .filter(([k, v]) => isEnvName(k) && (typeof v === "string" || typeof v === "number"))
        .map(([name, value]) => ({ name, value: String(value) }))
      return { entries: dedupe(entries), errors: [] }
    } catch {
      // Fall through to line parsing.
    }
  }

  const entries: EnvEntry[] = []
  const errors: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/)
    if (m) {
      const value = unquote(m[2]!)
      if (value) entries.push({ name: m[1]!, value })
      continue
    }
    const guess = KEY_PREFIXES.find(([prefix]) => line.startsWith(prefix))
    if (guess && !/\s/.test(line)) entries.push({ name: guess[1], value: line, guessed: true })
    else errors.push(`Couldn't read "${mask(line)}". Use NAME=value.`)
  }
  return { entries: dedupe(entries), errors }
}

/** Decide where each pasted variable goes: a provider credential when unambiguous, otherwise a managed env var. */
export function planEnvImport(entries: EnvEntry[], integrations: ReadonlyArray<IntegrationLike>): EnvPlan[] {
  const byName = new Map<string, IntegrationLike[]>()
  for (const integration of integrations) {
    for (const method of integration.methods) {
      if (method.type !== "env") continue
      for (const name of method.names ?? []) {
        const list = byName.get(name) ?? []
        list.push(integration)
        byName.set(name, list)
      }
    }
  }
  return entries.map((entry) => {
    const owners = byName.get(entry.name) ?? []
    const base = { name: entry.name, masked: mask(entry.value), guessed: Boolean(entry.guessed) }
    const only = owners.length === 1 ? owners[0]! : undefined
    const envNames = only?.methods.flatMap((m) => (m.type === "env" ? (m.names ?? []) : [])) ?? []
    const acceptsKey = only?.methods.some((m) => m.type === "key") ?? false
    if (only && acceptsKey && envNames.length === 1) {
      return { ...base, action: "credential", integration: { id: only.id, name: only.name } }
    }
    const first = owners[0]
    return { ...base, action: "env", ...(first ? { integration: { id: first.id, name: first.name } } : {}) }
  })
}

export function mask(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length)
  if (value.length <= 16) return `${value.slice(0, 2)}••••${value.slice(-2)}`
  return `${value.slice(0, 6)}••••${value.slice(-4)}`
}

export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

function unquote(value: string): string {
  const v = value.trim()
  const q = v[0]
  if ((q === '"' || q === "'" || q === "`") && v.endsWith(q) && v.length >= 2) return v.slice(1, -1)
  return v.replace(/\s+#.*$/, "").trim()
}

function dedupe(entries: EnvEntry[]): EnvEntry[] {
  const map = new Map<string, EnvEntry>()
  for (const e of entries) map.set(e.name, e)
  return [...map.values()]
}
