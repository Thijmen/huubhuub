/**
 * The phone app's API with made-up Dutch conversations, for working on the app's screens without a bot,
 * Telegram or OpenCode. Messages you send get a canned reply that streams in, with a web search first.
 *
 *   bun scripts/app-demo.ts            # then open the printed link on the phone or emulator
 *   PORT=8090 HOST=10.0.2.2 bun scripts/app-demo.ts
 *
 * The Android emulator reaches this machine at 10.0.2.2, which is the default host.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppAccess } from "../src/app-api/access"
import { AppPush } from "../src/app-api/push"
import { startAppApi } from "../src/app-api/server"
import { TelegramLinks } from "../src/app-api/telegram-link"
import type { Chats } from "../src/chats"
import { loadConfig } from "../src/config"
import type { Bridge, SessionEvent } from "../src/opencode"
import { Personas } from "../src/personas"
import { Questions } from "../src/question"
import { Store, type ChatKey } from "../src/store"

const PORT = Number(process.env.PORT ?? 8090)
const HOST = process.env.HOST ?? "10.0.2.2"
const PUBLIC = `http://${HOST}:${PORT}`
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const now = Date.now()
const at = (ago: number) => now - ago

type Msg = Record<string, unknown> & { id: string; time: { created: number; completed?: number } }
type Conv = { title: string; ago: number; pinned?: boolean; busy?: boolean; messages: Msg[] }

let seq = 0
const user = (text: string, ago: number): Msg => ({ id: `u${++seq}`, type: "user", text, time: { created: at(ago) } })
const huub = (text: string, ago: number, tools: { name: string; input: Record<string, unknown> }[] = []): Msg => ({
  id: `a${++seq}`,
  type: "assistant",
  time: { created: at(ago), completed: at(ago) + 1000 },
  content: [...tools.map((t, i) => ({ type: "tool", id: `t${seq}-${i}`, name: t.name, state: { status: "completed", input: t.input } })), ...(text ? [{ type: "text", text }] : [])],
})

const conversations: Record<string, Conv> = {
  ses_texel: {
    title: "Weekendje Texel",
    ago: 0,
    pinned: true,
    messages: [
      user("Kun je een weekendje Texel voor ons plannen? Vrijdag na het werk heen, zondag rond de middag terug 🚲", 40 * MIN),
      huub(
        "### Weekendje Texel\n\nGoed plan, Texel is in oktober lekker rustig. Zo zou ik het doen:\n\n- **Vrijdag:** boot van 19:30 uit Den Helder, frietje bij de haven\n- **Zaterdag:** fietsen naar de vuurtoren bij De Cocksdorp\n- **Zondag:** uitwaaien op het strand, boot van 13:30 terug\n\nBoek de boot vooraf via `teso.nl`, dat scheelt wachten.\n\n```reservering\nDen Helder → Texel  vr 19:30\nTexel → Den Helder  zo 13:30\n2 personen · 1 auto\n```",
        39 * MIN,
        [{ name: "webfetch", input: { url: "https://www.teso.nl/dienstregeling" } }],
      ),
      user("Top! Is er dit weekend nog iets leuks te doen daar?", 30 * MIN),
      huub("", 29 * MIN, [
        { name: "websearch", input: { query: "Texel dit weekend evenementen" } },
        { name: "websearch", input: { query: "Sterrenwacht Texel openingstijden" } },
        { name: "webfetch", input: { url: "https://www.ecomare.nl" } },
      ]),
      huub(
        "Zeker! Dit viel me op:\n\n1. **Zaterdag** streekmarkt in Den Burg, 10 tot 16 uur\n2. **Zaterdagavond** sterrenkijken bij de [Sterrenwacht](https://sterrenwachttexel.nl), wel reserveren\n3. **Zondag** zeehonden voeren bij Ecomare om 11:00\n\nZal ik je eraan herinneren om de sterrenwacht te boeken?",
        28 * MIN,
      ),
      user("Ja graag, morgen om 9 uur", 2 * MIN),
      huub("Komt goed 👍 Ik seintje je morgen om 09:00.", 1 * MIN, [{ name: "schedule_create", input: { name: "Sterrenwacht Texel reserveren" } }]),
    ],
  },
  ses_boodschappen: {
    title: "Boodschappenlijst",
    ago: 3 * HOUR,
    pinned: true,
    messages: [
      user("Zet er ook nog eieren en koriander op, en we hebben geen havermelk meer.", 3 * HOUR + 2 * MIN),
      huub("Staat erop! Dit is je lijst nu:\n\n- [ ] Citroenen\n- [ ] Volkoren pasta\n- [ ] Eieren\n- [ ] Koriander\n- [ ] Havermelk\n\nHavermelk en citroenen staan erop ✓", 3 * HOUR),
    ],
  },
  ses_eten: {
    title: "Eten met spinazie & feta",
    ago: 1 * HOUR,
    messages: [
      user("Wat zullen we vanavond eten? We hebben nog spinazie, feta en een paar eieren.", 1 * HOUR + MIN),
      huub("Daar kun je prima wat mee! Eén vraagje voordat ik een recept kies:", 1 * HOUR),
    ],
  },
  ses_tandarts: {
    title: "Herinnering tandarts",
    ago: DAY + 2 * HOUR,
    messages: [user("Herinner me donderdag aan de tandarts", DAY + 2 * HOUR + MIN), huub("Ik seintje je donderdag om 08:00", DAY + 2 * HOUR)],
  },
  ses_cadeau: {
    title: "Cadeau voor mama",
    ago: 3 * DAY,
    messages: [huub("Wat voor cadeau zoek je, en wat mag het kosten?", 3 * DAY + MIN), user("Iets onder de €50 graag, ze houdt van tuinieren", 3 * DAY)],
  },
  ses_monstera: {
    title: "Monstera redden",
    ago: 12 * DAY,
    messages: [user("Mijn monstera krijgt gele bladeren 😟", 12 * DAY + MIN), huub("Gele bladeren? Dan krijgt ie waarschijnlijk te veel water. Laat de bovenste paar centimeter aarde eerst opdrogen.", 12 * DAY)],
  },
  ses_brief: {
    title: "Sollicitatiebrief nakijken",
    ago: 22 * DAY,
    messages: [user("Wil je mijn sollicitatiebrief nakijken?", 22 * DAY + MIN), huub("De tweede alinea is sterk, alleen de opening mag wat persoonlijker.", 22 * DAY)],
  },
}

const store = new Store(mkdtempSync(join(tmpdir(), "huub-demo-")))
const config = loadConfig({ TELEGRAM_BOT_TOKEN: "demo", APP_PORT: String(PORT), APP_HOST: "0.0.0.0", APP_PUBLIC_URL: PUBLIC })
const sanne = store.createAppPerson("Sanne")
const chat = store.appChatOf(sanne.id)
const db = (store as unknown as { db: import("bun:sqlite").Database }).db

for (const [sessionID, conv] of Object.entries(conversations)) {
  const key: ChatKey = { chatId: chat, threadId: store.nextAppThread(chat) }
  store.set(key, sessionID)
  if (conv.pinned) store.setPinned(key, true)
  db.query("UPDATE threads SET updated_at = ? WHERE session_id = ?").run(at(conv.ago), sessionID)
}

const listeners = new Map<string, Set<(e: SessionEvent) => void>>()
const busy = new Set<string>()
const emit = (sessionID: string, type: string, data: Record<string, unknown> = {}) => {
  for (const fn of listeners.get(sessionID) ?? []) fn({ type, data: { sessionID, ...data } } as unknown as SessionEvent)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const bridge = {
  host: {
    message: {
      list: async ({ sessionID, limit = 50 }: { sessionID: string; limit?: number }) => ({
        data: [...(conversations[sessionID]?.messages ?? [])].reverse().slice(0, limit),
        cursor: {},
      }),
    },
    session: { active: async () => Object.fromEntries([...busy].map((id) => [id, {}])) },
  },
  getSession: async (id: string) => ({ title: conversations[id]?.title ?? null, time: { updated: now } }),
  subscribe: (id: string, fn: (e: SessionEvent) => void) => {
    const set = listeners.get(id) ?? new Set()
    listeners.set(id, set.add(fn))
    return () => set.delete(fn)
  },
  interrupt: async (id: string) => {
    busy.delete(id)
    emit(id, "session.execution.interrupted")
  },
  transcript: async () => [],
} as unknown as Bridge

const questions = new Questions({ reply: async () => {} }, () => 60)
questions.open("ses_eten", "form_eten", [
  {
    key: "tijd",
    title: "Hoeveel tijd hebben jullie vanavond?",
    question: "",
    multiple: false,
    options: [
      { label: "⚡ Snel, max 15 minuten", description: "Bijv. omelet met spinazie" },
      { label: "🍳 Een half uurtje is prima", description: "Bijv. shakshuka met feta" },
      { label: "🫕 We hebben de tijd", description: "Bijv. spanakopita uit de oven" },
    ],
  },
])

const REPLY =
  "Goeie vraag! Ik heb even gekeken:\n\n- **Regenjas**, het waait altijd op Texel\n- **Fietsslot**, je huurt er fietsen\n- **Verrekijker** voor de zeehonden\n\nVergeet de bootkaartjes niet 😉"

/** Pretend to be the agent: a web search, then a reply that streams in word by word. */
async function answer(sessionID: string, text: string) {
  const conv = conversations[sessionID]!
  conv.messages.push(user(text, 0))
  conv.messages.at(-1)!.time.created = Date.now()
  busy.add(sessionID)
  emit(sessionID, "session.inbox.delivered")
  await sleep(600)
  emit(sessionID, "session.execution.started")
  const tool = `t${++seq}`
  emit(sessionID, "session.tool.input.started", { id: tool, name: "websearch" })
  await sleep(300)
  emit(sessionID, "session.tool.called", { id: tool, input: { query: text.slice(0, 40) } })
  await sleep(2500)
  emit(sessionID, "session.tool.success", { id: tool })
  const step: Msg = { id: `a${++seq}`, type: "assistant", time: { created: Date.now(), completed: Date.now() }, content: [{ type: "tool", id: tool, name: "websearch", state: { status: "completed", input: { query: text.slice(0, 40) } } }] }
  conv.messages.push(step)
  const id = `a${++seq}`
  let sent = ""
  for (const word of REPLY.split(/(?<= )/)) {
    if (!busy.has(sessionID)) return
    sent += word
    emit(sessionID, "session.text.delta", { assistantMessageID: id, ordinal: 0, delta: word })
    await sleep(70)
  }
  emit(sessionID, "session.text.ended", { assistantMessageID: id, ordinal: 0, text: sent })
  conv.messages.push({ id, type: "assistant", time: { created: Date.now(), completed: Date.now() }, content: [{ type: "text", text: sent }] })
  busy.delete(sessionID)
  emit(sessionID, "session.execution.succeeded")
}

const chats = {
  startFromApp: async (personId: number) => {
    const chatId = store.appChatOf(personId)
    const key = { chatId, threadId: store.nextAppThread(chatId) }
    const sessionID = `ses_${key.threadId}_${Date.now()}`
    conversations[sessionID] = { title: "Wat nemen we mee?", ago: 0, messages: [] }
    store.set(key, sessionID)
    return { key, sessionID }
  },
  sendFromApp: async (sessionID: string, _personId: number, text: string) => {
    const thread = store.bySession(sessionID)
    if (thread) store.touch(thread, sanne.id)
    void answer(sessionID, text)
  },
} as unknown as Chats

const access = new AppAccess(store, () => PUBLIC)
const server = startAppApi({
  config,
  store,
  bridge,
  chats,
  questions,
  access,
  push: new AppPush({ store, bridge, send: async () => [] }),
  transcriber: { transcribeRecording: async () => "Wat nemen we mee naar Texel?" },
  serverName: () => "Huub",
  settings: {
    personas: new Personas(store, () => "Europe/Amsterdam"),
    limits: {
      spend: async (userId: number) => ({
        userId,
        exempt: false,
        day: { period: "day", spent: 0.42, limit: 2, from: 0, resetsAt: now + 8 * HOUR },
        month: { period: "month", spent: 7.3, limit: 20, from: 0, resetsAt: now + 6 * DAY },
      }),
    },
    scheduler: { running: () => false, runNow: () => {}, reschedule: () => {} },
    schedules: { delete: (s: { id: number }) => store.deleteSchedule(s.id) },
    timeZone: () => "Europe/Amsterdam",
  },
  telegramLinks: new TelegramLinks({ store, botUsername: () => "huubhuub_demo_bot", allow: () => {} }),
})

const invite = () => access.invite(sanne.id).url.split("#")[1]!
const code = invite()
const deep = `huubhuub://pair?server=${encodeURIComponent(PUBLIC)}&code=${code}`
console.log(`Demo app API on :${server.port}, as Sanne.`)
console.log(`Invite page: ${PUBLIC}/pair#${code}`)
console.log(`App link:    ${deep}`)
console.log(`Expo Go:     exp://127.0.0.1:8081/--/pair?server=${encodeURIComponent(PUBLIC)}&code=${code}`)
