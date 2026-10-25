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

/** What kind of thing a tool call does. The app turns this into a label in the phone's language. */
export type ToolKind = "web" | "search" | "shell" | "read" | "write" | "edit" | "files" | "helper" | "plan" | "skill" | "other"

/** What a tool call is doing, with the detail worth showing (a host, a query, a file name). */
export function describeTool(name: string, input: Record<string, unknown> | undefined): { kind: ToolKind; detail: string } {
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
  switch (name.toLowerCase()) {
    case "webfetch":
    case "fetch":
      return { kind: "web", detail: host(str("url")) }
    case "websearch":
    case "search":
      return { kind: "search", detail: str("query") }
    case "bash":
    case "shell":
      return { kind: "shell", detail: str("description") || str("command") }
    case "read":
      return { kind: "read", detail: file() }
    case "write":
      return { kind: "write", detail: file() }
    case "edit":
    case "multiedit":
    case "patch":
    case "apply_patch":
      return { kind: "edit", detail: file() }
    case "grep":
    case "glob":
    case "list":
    case "ls":
      return { kind: "files", detail: "" }
    case "task":
    case "agent":
      return { kind: "helper", detail: str("description") }
    case "todowrite":
    case "todoread":
    case "todo":
      return { kind: "plan", detail: "" }
    case "skill":
      return { kind: "skill", detail: str("name") }
    default:
      return { kind: "other", detail: name }
  }
}

/** A short, friendly description of what a tool call is doing. */
export function toolActivity(name: string, input: Record<string, unknown> | undefined): string {
  const { kind, detail } = describeTool(name, input)
  const with_ = (text: string, d: string) => (d ? `${text} ${truncate(d, 50)}` : text)
  switch (kind) {
    case "web":
      return with_("🌐 Reading", detail)
    case "search":
      return with_("🔎 Searching the web for", quote(detail))
    case "shell":
      return with_("⚙️ Running", detail)
    case "read":
      return with_("📖 Reading", detail)
    case "write":
      return with_("✍️ Writing", detail)
    case "edit":
      return with_("✏️ Editing", detail)
    case "files":
      return "🔎 Searching the files"
    case "helper":
      return with_("🤝 Asking a helper to", lowerFirst(detail))
    case "plan":
      return "📝 Planning"
    case "skill":
      return with_("📚 Loading skill", detail)
    case "other":
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
