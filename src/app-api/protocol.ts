/**
 * The phone app's API: requests, responses and live events. The app imports this file for its types only,
 * so it must stay self-contained (no imports) and free of runtime code other than constants.
 */

/** Bumped when a change would break apps already installed. */
export const APP_API_VERSION = 1

export interface PairRequest {
  /** The code from the invite link. */
  code: string
  /** Shown on the admin UI's People page, e.g. "Pixel 8". */
  deviceName?: string
  platform?: "android" | "ios" | "web"
}

export interface PairResponse {
  /** Send as `Authorization: Bearer <token>` on every other request. Shown once; the server keeps only a hash. */
  token: string
  me: Me
}

export interface Me {
  person: { id: number; name: string | null }
  device: { id: string; name: string | null }
  /** The Telegram bot's name, or "HuubHuub". */
  serverName: string
  apiVersion: number
  features: {
    /** The server can transcribe voice notes. */
    voice: boolean
    /** This person also uses Telegram, so new conversations show up there too. */
    telegram: boolean
  }
}

export interface PushTokenRequest {
  /** An Expo push token, or null to stop notifications on this phone. */
  token: string | null
}

export interface ConversationSummary {
  id: string
  title: string | null
  /** Epoch ms of the last message. */
  updatedAt: number
  /** Huub is working on a reply. */
  busy: boolean
  /** The start of the last message, as plain text. */
  preview: string | null
  /** The conversation is also a Telegram topic. */
  telegram: boolean
}

export interface ConversationList {
  conversations: ConversationSummary[]
}

/** A photo to send along: JPEG, PNG, GIF or WebP, base64-encoded. At most 4 per message, 10 MB each. */
export interface ImageUpload {
  data: string
  name?: string
}

export interface NewConversationRequest {
  /** Send this straight away. */
  text?: string
  images?: ImageUpload[]
}

export interface SendRequest {
  /** May be empty when there are images. */
  text?: string
  images?: ImageUpload[]
}

/** A voice note to turn into text; send the text as a message afterwards. */
export interface TranscribeRequest {
  /** Base64-encoded audio: AAC in MP4 (`.m4a`) or OGG/Opus. */
  audio: string
  mime: string
}

export interface TranscribeResponse {
  text: string
}

export interface AppImage {
  name: string | null
  /** A data URI, or null when the image is too large to send along. */
  uri: string | null
}

export type AppMessage =
  | { id: string; role: "user"; createdAt: number; text: string; images: AppImage[] }
  | {
      id: string
      role: "assistant"
      createdAt: number
      /** Text fragments in order; join them with blank lines. Markdown. */
      parts: string[]
      done: boolean
      error: string | null
    }

export interface ConversationPage {
  conversation: ConversationSummary
  /** Oldest first. */
  messages: AppMessage[]
  /** Pass as `?cursor=` to load older messages; null when there are none. */
  older: string | null
  question: Question | null
}

export interface QuestionField {
  key: string
  title: string
  question: string
  multiple: boolean
  options: { label: string; description?: string }[]
}

/** A question the agent asked. Only `pending` ones need an answer. */
export interface Question {
  formID: string
  status: "pending" | "answered" | "skipped" | "timeout" | "cancelled"
  /** Which field is on screen; several are asked one at a time. */
  index: number
  total: number
  fields: QuestionField[]
  /** Ticked options of a multiple-choice field. */
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

export interface QuestionRequest {
  formID: string
  action: QuestionAction
}

export type ToolKind = "web" | "search" | "shell" | "read" | "write" | "edit" | "files" | "helper" | "plan" | "skill" | "other"

/** Server-sent events on `/v1/conversations/:id/events`, one JSON object per `data:` line. */
export type AppEvent =
  | { type: "ready" }
  | { type: "run.started" }
  | { type: "run.ended"; outcome: "succeeded" | "failed" | "interrupted"; error?: string }
  /** A text fragment of an assistant message grew (`delta`) or is final (`text`). */
  | { type: "text"; messageId: string; ordinal: number; delta?: string; text?: string }
  /** A tool call started, got its input, or finished. */
  | { type: "activity"; id: string; kind: ToolKind; detail: string; status: "running" | "ok" | "error" }
  | { type: "retry"; attempt: number; error: string }
  | { type: "title"; title: string }
  /** Something changed that isn't streamed (a new message from Telegram, a finished run): reload the latest page. */
  | { type: "refresh" }
  | { type: "question"; question: Question }

export interface ApiError {
  error: string
}
