import { truncate } from "./format"

/** Shown while the agent works without a tool running, rotating every few seconds. */
export const VERBS = [
  "Pondering",
  "Mulling it over",
  "Percolating",
  "Noodling",
  "Cogitating",
  "Brewing",
  "Tinkering",
  "Musing",
  "Ruminating",
  "Scheming",
  "Conjuring",
  "Deliberating",
] as const

const VERB_MS = 4000

/** A short, friendly description of what a tool call is doing. */
export function toolActivity(name: string, input: Record<string, unknown> | undefined): string {
  const str = (...keys: string[]) => {
    for (const k of keys) {
      const v = input?.[k]
      if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ")
    }
    return ""
  }
  const file = () => {
    const p = str("filePath", "path", "file")
    return p ? p.split("/").filter(Boolean).at(-1) ?? p : ""
  }
  const with_ = (text: string, detail: string) => (detail ? `${text} ${truncate(detail, 50)}` : text)
  switch (name.toLowerCase()) {
    case "webfetch":
    case "fetch":
      return with_("🌐 Reading", host(str("url")))
    case "websearch":
    case "search":
      return with_("🔎 Searching the web for", quote(str("query")))
    case "bash":
    case "shell":
      return with_("⚙️ Running", str("description") || str("command"))
    case "read":
      return with_("📖 Reading", file())
    case "write":
      return with_("✍️ Writing", file())
    case "edit":
    case "multiedit":
    case "patch":
    case "apply_patch":
      return with_("✏️ Editing", file())
    case "grep":
    case "glob":
    case "list":
    case "ls":
      return "🔎 Searching the files"
    case "task":
    case "agent":
      return with_("🤝 Asking a helper to", lowerFirst(str("description")))
    case "todowrite":
    case "todoread":
    case "todo":
      return "📝 Planning"
    case "skill":
      return with_("📚 Loading skill", str("name"))
    default:
      return `🔧 Using ${name}`
  }
}

/** The status line under the reply: current activity, or a rotating verb, with elapsed time. */
export function statusLine(activity: string | undefined, elapsedMs: number, seed: number): string {
  const seconds = Math.floor(elapsedMs / 1000)
  const text = activity ?? `✻ ${VERBS[(seed + Math.floor(elapsedMs / VERB_MS)) % VERBS.length]}`
  return `${text}${text.endsWith("…") ? "" : "…"} ${seconds}s`
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function quote(s: string): string {
  return s ? `"${truncate(s, 40)}"` : ""
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : ""
}
