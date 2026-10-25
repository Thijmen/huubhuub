import { getLocales } from "expo-localization"
import type { ToolKind } from "@server/protocol"

const en = {
  appName: "HuubHuub",
  // Pairing
  pairTitle: "Sign in",
  pairIntro: "Scan the QR code from your invite, or open the invite link on this phone.",
  pairScanHint: "Point the camera at the QR code",
  pairCameraAsk: "To scan the QR code, HuubHuub needs the camera.",
  pairCameraAllow: "Allow camera",
  pairPasteInstead: "Paste the link instead",
  pairPastePlaceholder: "https://…/pair#…",
  pairPasteSubmit: "Sign in",
  pairConfirm: "Sign in to {server}?",
  pairBusy: "Signing in…",
  pairBadLink: "That doesn't look like a HuubHuub invite.",
  // List
  conversations: "Conversations",
  newConversation: "New conversation",
  emptyListTitle: "Nothing here yet",
  greeting: "Hi {name}!",
  emptyListBody: "Start a conversation with Huub. Ask anything, in your own words.",
  untitled: "New conversation",
  typing: "Huub is typing…",
  onTelegram: "Also on Telegram",
  // Chat
  composerPlaceholder: "Message Huub…",
  newChatTitle: "What can I help with?",
  newChatBody: "Ask a question, plan something, or just think out loud.",
  thinking: "Thinking",
  stopped: "Stopped",
  loadOlder: "Load older messages",
  replyFailed: "The reply failed: {error}",
  retrying: "Trying again (attempt {attempt})…",
  sendFailed: "Couldn't send: {error}",
  // Questions
  questionHint: "Or type your own answer below.",
  questionSubmit: "Done",
  questionSkip: "Skip",
  questionCount: "{index} of {total}",
  // Activity
  tool_web: "Reading {detail}",
  tool_search: "Searching the web",
  tool_shell: "Running a command",
  tool_read: "Reading {detail}",
  tool_write: "Writing {detail}",
  tool_edit: "Editing {detail}",
  tool_files: "Searching the files",
  tool_helper: "Asking a helper",
  tool_plan: "Planning",
  tool_skill: "Loading a skill",
  tool_other: "Working on it",
  // Settings
  settings: "Settings",
  signedInAs: "Signed in as",
  server: "Server",
  device: "This phone",
  notifications: "Notifications",
  notificationsOn: "On",
  notificationsOff: "Off. Turn them on in the phone's settings.",
  appVersion: "App version",
  checkUpdates: "Check for updates",
  upToDate: "You have the latest version.",
  updateReady: "Update downloaded. Restarting…",
  signOut: "Sign out",
  signOutConfirm: "Sign out of HuubHuub on this phone?",
  cancel: "Cancel",
  // Errors
  offline: "Can't reach the server. Check your connection.",
  signedOut: "This phone was signed out. Ask for a new invite.",
  genericError: "Something went wrong.",
  retry: "Try again",
  // Time
  now: "now",
  minutesAgo: "{n} min",
  yesterday: "yesterday",
}

export type Key = keyof typeof en

const nl: Record<Key, string> = {
  appName: "HuubHuub",
  pairTitle: "Inloggen",
  pairIntro: "Scan de QR-code van je uitnodiging, of open de uitnodigingslink op deze telefoon.",
  pairScanHint: "Richt de camera op de QR-code",
  pairCameraAsk: "Om de QR-code te scannen heeft HuubHuub de camera nodig.",
  pairCameraAllow: "Camera toestaan",
  pairPasteInstead: "Liever een link plakken",
  pairPastePlaceholder: "https://…/pair#…",
  pairPasteSubmit: "Inloggen",
  pairConfirm: "Inloggen bij {server}?",
  pairBusy: "Bezig met inloggen…",
  pairBadLink: "Dat lijkt geen HuubHuub-uitnodiging.",
  conversations: "Gesprekken",
  newConversation: "Nieuw gesprek",
  emptyListTitle: "Nog niks te zien",
  greeting: "Hoi {name}!",
  emptyListBody: "Begin een gesprek met Huub. Vraag wat je wilt, gewoon in je eigen woorden.",
  untitled: "Nieuw gesprek",
  typing: "Huub is aan het typen…",
  onTelegram: "Ook in Telegram",
  composerPlaceholder: "Bericht aan Huub…",
  newChatTitle: "Waar kan ik je mee helpen?",
  newChatBody: "Stel een vraag, plan iets, of denk gewoon hardop.",
  thinking: "Even nadenken",
  stopped: "Gestopt",
  loadOlder: "Oudere berichten laden",
  replyFailed: "Het antwoord mislukte: {error}",
  retrying: "Opnieuw proberen (poging {attempt})…",
  sendFailed: "Versturen mislukt: {error}",
  questionHint: "Of typ hieronder je eigen antwoord.",
  questionSubmit: "Klaar",
  questionSkip: "Overslaan",
  questionCount: "{index} van {total}",
  tool_web: "Leest {detail}",
  tool_search: "Zoekt op het web",
  tool_shell: "Voert een opdracht uit",
  tool_read: "Leest {detail}",
  tool_write: "Schrijft {detail}",
  tool_edit: "Past {detail} aan",
  tool_files: "Doorzoekt de bestanden",
  tool_helper: "Vraagt een hulpje",
  tool_plan: "Maakt een plan",
  tool_skill: "Laadt een vaardigheid",
  tool_other: "Is ermee bezig",
  settings: "Instellingen",
  signedInAs: "Ingelogd als",
  server: "Server",
  device: "Deze telefoon",
  notifications: "Meldingen",
  notificationsOn: "Aan",
  notificationsOff: "Uit. Zet ze aan in de instellingen van je telefoon.",
  appVersion: "Appversie",
  checkUpdates: "Zoeken naar updates",
  upToDate: "Je hebt de nieuwste versie.",
  updateReady: "Update gedownload. Even opnieuw opstarten…",
  signOut: "Uitloggen",
  signOutConfirm: "Uitloggen bij HuubHuub op deze telefoon?",
  cancel: "Annuleren",
  offline: "De server is niet bereikbaar. Controleer je verbinding.",
  signedOut: "Deze telefoon is uitgelogd. Vraag om een nieuwe uitnodiging.",
  genericError: "Er ging iets mis.",
  retry: "Opnieuw",
  now: "nu",
  minutesAgo: "{n} min",
  yesterday: "gisteren",
}

export const locale: "en" | "nl" = getLocales()[0]?.languageCode === "nl" ? "nl" : "en"
const strings: Record<Key, string> = locale === "nl" ? nl : en

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return strings[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""))
}

const TOOL_EMOJI: Record<ToolKind, string> = {
  web: "🌐",
  search: "🔎",
  shell: "⚙️",
  read: "📖",
  write: "✍️",
  edit: "✏️",
  files: "🗂️",
  helper: "🤝",
  plan: "📝",
  skill: "📚",
  other: "🔧",
}

/** "🔎 Searching the web: weekend Texel" */
export function toolLabel(kind: ToolKind, detail: string): string {
  const key = `tool_${kind}` as Key
  const usesDetail = strings[key].includes("{detail}")
  const short = detail.length > 40 ? `${detail.slice(0, 39)}…` : detail
  const text = usesDetail ? t(key, { detail: short || "…" }) : t(key)
  const extra = !usesDetail && short && kind !== "other" ? `: ${short}` : ""
  return `${TOOL_EMOJI[kind]} ${text}${extra}`
}

/** Short relative time for the conversation list. */
export function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return t("now")
  if (minutes < 60) return t("minutesAgo", { n: minutes })
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  if (sameDay) return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
  const yesterday = new Date(now - 86_400_000).toDateString() === new Date(at).toDateString()
  if (yesterday) return t("yesterday")
  const days = (now - at) / 86_400_000
  if (days < 7) return new Date(at).toLocaleDateString(locale, { weekday: "short" })
  return new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short" })
}
