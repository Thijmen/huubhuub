const TOKEN_KEY = "ocbot.admin.token"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const auth = {
  get: () => localStorage.getItem(TOKEN_KEY) ?? "",
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

let onUnauthorised: () => void = () => {}
export function setUnauthorisedHandler(fn: () => void) {
  onUnauthorised = fn
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, token = auth.get()): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) onUnauthorised()
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText)
  return data as T
}

export const enc = encodeURIComponent

export type Method =
  | { type: "key"; label?: string; form?: FormField[] }
  | { type: "env"; names: string[] }
  | { type: "oauth"; id: string; label: string; form?: FormField[] }
  | { type: "command"; id: string; label: string; command: string[] }

export type FormField = {
  key: string
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  placeholder?: string
  default?: unknown
  options?: { value: string; label: string; description?: string }[]
  url?: string
}

export type Connection =
  | { type: "credential"; id: string; label: string; method: "key" | "oauth" }
  | { type: "env"; name: string; masked?: string }

export interface Provider {
  id: string
  name: string
  methods: Method[]
  connections: Connection[]
  models: number
  custom?: boolean
}

export interface Overview {
  bot?: { username: string; name: string; topics?: boolean; usersCreateTopics?: boolean }
  threadMode: "auto" | "off"
  allowedUsers: number[]
  defaultModel: string | null
  defaultAgent: string | null
  models: number
  providers: { id: string; name: string; models: number }[]
  mcp: { name: string; status: McpStatus }[]
  conversations: number
  uptime: number
  version: string
}

export type McpStatus = "connected" | "pending" | "disabled" | "failed" | "needs_auth"

export type McpConfig =
  | {
      type: "local"
      command: string[]
      cwd?: string
      environment?: Record<string, string>
      disabled?: boolean
      timeout?: { startup?: number }
    }
  | {
      type: "remote"
      url: string
      headers?: Record<string, string>
      oauth?: false | Record<string, unknown>
      disabled?: boolean
      timeout?: { startup?: number }
    }

export interface McpServer {
  name: string
  status: McpStatus
  error?: string
  source: "admin" | "config"
  config: McpConfig | null
  integrationID?: string
}

export interface EnvPlan {
  name: string
  masked: string
  guessed: boolean
  action: "credential" | "env"
  integration?: { id: string; name: string }
  protected: boolean
  exists: boolean
}

export interface SettingInfo {
  key: "DEFAULT_MODEL" | "DEFAULT_AGENT" | "ALLOWED_USER_IDS" | "THREAD_MODE"
  value: string
  source: "admin" | "env" | "default"
  envValue: string
}

export interface SettingsResponse {
  settings: SettingInfo[]
  models: { ref: string; name: string; provider: string }[]
  agents: { id: string; name: string; description?: string }[]
}

export interface ThreadRow {
  chatId: number
  threadId: number
  sessionID: string
  updatedAt: number
  title: string | null
  model: string | null
  agent: string | null
  cost: number
  tokens: number
}

export interface OAuthAttempt {
  attemptID: string
  url: string
  instructions: string
  mode: "auto" | "code"
  time: { created: number; expires: number }
}

export type OAuthStatus = { status: "pending" | "complete" | "expired" } | { status: "failed"; message: string }
