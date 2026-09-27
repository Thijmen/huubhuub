import type { McpConfig } from "./opencode"

type Json = Record<string, unknown>

/**
 * Accept MCP server definitions in the shapes people usually copy from READMEs:
 * Claude Desktop / Cursor (`{ mcpServers: { name: { command, args, env } } }`),
 * OpenCode (`{ mcp: { servers: {...} } }` or `{ mcp: { name: {...} } }`), a bare map of servers,
 * or a single server object (which then needs a name).
 */
export function parseMcpImport(text: string, fallbackName?: string): { servers: { name: string; config: McpConfig }[]; errors: string[] } {
  let data: unknown
  try {
    data = JSON.parse(stripJsonComments(text))
  } catch (err) {
    return { servers: [], errors: [`Invalid JSON: ${(err as Error).message}`] }
  }
  if (!isObject(data)) return { servers: [], errors: ["Expected a JSON object."] }

  const map = pickServerMap(data)
  const entries: [string, unknown][] = map
    ? Object.entries(map)
    : [[fallbackName || guessName(data) || "", data]]

  const servers: { name: string; config: McpConfig }[] = []
  const errors: string[] = []
  for (const [name, raw] of entries) {
    if (!name) {
      errors.push("Give this server a name.")
      continue
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      errors.push(`"${name}": names may only contain letters, digits, ".", "_" and "-".`)
      continue
    }
    try {
      servers.push({ name, config: normalizeServer(raw) })
    } catch (err) {
      errors.push(`"${name}": ${(err as Error).message}`)
    }
  }
  return { servers, errors }
}

export function normalizeServer(raw: unknown): McpConfig {
  if (!isObject(raw)) throw new Error("expected an object")
  const common = {
    ...(raw.disabled === true || raw.enabled === false ? { disabled: true } : {}),
    ...(typeof raw.codemode === "boolean" ? { codemode: raw.codemode } : {}),
    ...(typeof raw.timeout === "number" ? { timeout: { startup: raw.timeout } } : {}),
    ...(isObject(raw.timeout) ? { timeout: raw.timeout as { startup?: number } } : {}),
  }

  const url = typeof raw.url === "string" ? raw.url : typeof raw.serverUrl === "string" ? raw.serverUrl : undefined
  if (url || raw.type === "remote" || raw.type === "http" || raw.type === "sse" || raw.type === "streamable-http") {
    if (!url) throw new Error("remote servers need a url")
    const headers = stringMap(raw.headers)
    return {
      type: "remote",
      url,
      ...(headers ? { headers } : {}),
      ...(raw.oauth === false || isObject(raw.oauth) ? { oauth: raw.oauth as false } : {}),
      ...common,
    }
  }

  let command: string[]
  if (Array.isArray(raw.command)) command = raw.command.map(String)
  else if (typeof raw.command === "string") {
    const args = Array.isArray(raw.args) ? raw.args.map(String) : []
    command = args.length ? [raw.command, ...args] : splitCommand(raw.command)
  } else throw new Error("local servers need a command")
  if (command.length === 0 || !command[0]) throw new Error("command is empty")

  const environment = stringMap(raw.environment) ?? stringMap(raw.env)
  return {
    type: "local",
    command,
    ...(typeof raw.cwd === "string" && raw.cwd ? { cwd: raw.cwd } : {}),
    ...(environment ? { environment } : {}),
    ...common,
  }
}

/** Split a command line on whitespace, honouring single and double quotes. */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | undefined
  let started = false
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur)
      cur = ""
      started = false
    } else cur += ch
  }
  if (started || cur) out.push(cur)
  return out
}

/** Parse `KEY=value` lines (or `Key: value` for headers) into a map. */
export function parsePairs(text: string, separator: "=" | ":" = "="): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const i = line.indexOf(separator)
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

function pickServerMap(data: Json): Json | undefined {
  if (isObject(data.mcpServers)) return data.mcpServers
  if (isObject(data.mcp)) return isObject(data.mcp.servers) ? data.mcp.servers : data.mcp
  if (isObject(data.servers)) return data.servers
  if (looksLikeServer(data)) return undefined
  const values = Object.values(data)
  if (values.length > 0 && values.every((v) => isObject(v) && looksLikeServer(v))) return data
  return undefined
}

function looksLikeServer(v: Json): boolean {
  return "command" in v || "url" in v || "serverUrl" in v || v.type === "local" || v.type === "remote"
}

function guessName(data: Json): string | undefined {
  return typeof data.name === "string" ? data.name : undefined
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!isObject(v)) return undefined
  const entries = Object.entries(v).map(([k, val]) => [k, String(val)] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function stripJsonComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1")
}
