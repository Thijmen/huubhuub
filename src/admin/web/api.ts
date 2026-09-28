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

/** Read a server-sent event stream with the auth header, which EventSource can't send. */
export async function stream(path: string, onEvent: (event: string, data: unknown) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${auth.get()}` }, signal })
  if (res.status === 401) onUnauthorised()
  if (!res.ok || !res.body) throw new ApiError(res.status, res.statusText)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += value
    let cut: number
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      let event = "message"
      const data: string[] = []
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7)
        else if (line.startsWith("data: ")) data.push(line.slice(6))
      }
      if (data.length) onEvent(event, JSON.parse(data.join("\n")))
    }
  }
}

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
  key: "DEFAULT_MODEL" | "DEFAULT_AGENT" | "ALLOWED_USER_IDS" | "THREAD_MODE" | "QUESTION_TIMEOUT_MINUTES" | "SCHEDULE_TIMEZONE"
  value: string
  source: "admin" | "env" | "default"
  envValue: string
}

export interface SettingsResponse {
  settings: SettingInfo[]
  models: { ref: string; name: string; provider: string }[]
  agents: { id: string; name: string; description?: string }[]
}

export type RunStatus = "running" | "ok" | "failed" | "silent" | "skipped" | "missed"

export interface ScheduleRun {
  id: number
  scheduleId: number
  sessionID: string | null
  startedAt: number
  endedAt: number | null
  status: RunStatus
  error: string | null
}

export interface ScheduleInfo {
  id: number
  chatId: number
  name: string
  kind: "cron" | "interval" | "once"
  spec: string
  prompt: string
  model: string | null
  agent: string | null
  silent: boolean
  paused: boolean
  failStreak: number
  nextAt: number | null
  createdAt: number
  description: string
  running: boolean
  runs: ScheduleRun[]
}

export interface SchedulesResponse {
  timeZone: string
  chats: { id: number; title: string | null }[]
  schedules: ScheduleInfo[]
}

export interface SchedulePreview {
  kind: ScheduleInfo["kind"]
  spec: string
  description: string
  upcoming: number[]
  timeZone: string
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
  busy: boolean
}

export type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
type Base = { id: string; time: { created: number; completed?: number }; metadata?: Record<string, unknown> }
type Err = { type: string; message: string }

export type ToolState =
  | { status: "streaming"; input: string }
  | { status: "running"; input: Record<string, unknown> }
  | { status: "completed"; input: Record<string, unknown>; content: ToolContent[] }
  | { status: "error"; input: Record<string, unknown>; error: Err; content?: ToolContent[] }

export type ToolContent = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string | null }

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; time?: { created: number; completed?: number } }
  | { type: "tool"; id: string; name: string; state: ToolState; time: { created: number; ran?: number; completed?: number } }

export type ChatMessage =
  | (Base & { type: "user"; text: string; files?: { name: string | null; mime: string; preview: string | null }[] })
  | (Base & {
      type: "assistant"
      agent: string
      model: { providerID: string; id: string }
      content: AssistantPart[]
      finish?: string
      cost?: number
      tokens?: Tokens
      error?: Err
      retry?: { attempt: number; at: number; error: Err }
    })
  | (Base & { type: "agent-switched"; agent: string; previous?: string })
  | (Base & { type: "model-switched"; model: { providerID: string; id: string }; previous?: { providerID: string; id: string } })
  | (Base & { type: "location-switched" })
  | (Base & { type: "synthetic" | "system"; text: string; description?: string })
  | (Base & { type: "skill"; name: string; text: string })
  | (Base & { type: "shell"; command: string; status: string; exit?: number | string; output?: { output: string } })
  | (Base & { type: "compaction"; status: "running" | "completed" | "failed"; reason: string; summary?: string })
  | (Base & { type: "idle"; outcome: "succeeded" | "failed" | "interrupted" })

export interface Conversation {
  session: {
    id: string
    title: string | null
    model: string | null
    agent: string | null
    cost: number
    tokens: Tokens
    created: number
    updated: number
  }
  key: { chatId: number; threadId: number } | null
  bot: string | null
  busy: boolean
  question: PendingQuestion | null
  messages: ChatMessage[]
  older: string | null
}

export interface PendingQuestion {
  formID: string
  status: "pending" | "answered" | "skipped" | "timeout" | "cancelled"
  index: number
  total: number
  fields: { key: string; title: string; question: string; multiple: boolean; options: { label: string; description?: string }[] }[]
  selected: number[]
  answers: (string | string[] | null)[]
  expiresAt: number
}

export type QuestionAction =
  | { type: "pick"; option: number }
  | { type: "toggle"; option: number }
  | { type: "submit" }
  | { type: "skip" }
  | { type: "text"; text: string }

export interface OAuthAttempt {
  attemptID: string
  url: string
  instructions: string
  mode: "auto" | "code"
  time: { created: number; expires: number }
}

export type OAuthStatus = { status: "pending" | "complete" | "expired" } | { status: "failed"; message: string }
