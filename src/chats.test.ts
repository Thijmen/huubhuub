import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Api } from "grammy"
import type { User } from "grammy/types"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Chats, type PromptSource } from "./chats"
import { loadConfig } from "./config"
import type { Bridge } from "./opencode"
import { Questions } from "./question"
import { isAppChat, Store, type ChatKey } from "./store"

let dir: string
let store: Store
let telegram: { method: string; chatId: number; text?: string; threadId?: number }[]
let prompts: { sessionID: string; text: string }[]
let sources: [string, PromptSource][]
let notices: { key: ChatKey; html: string }[]
let chats: Chats
let topics = 100
let checked: number[]
let questions: Questions

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chats-"))
  store = new Store(dir)
  telegram = []
  prompts = []
  sources = []
  notices = []
  checked = []
  let sessions = 0
  const api = {
    getChat: async (id: number) => ({ id, type: "private" }),
    createForumTopic: async (chatId: number) => {
      const threadId = ++topics
      telegram.push({ method: "createForumTopic", chatId, threadId })
      return { message_thread_id: threadId }
    },
    sendMessage: async (chatId: number, text: string, opts?: { message_thread_id?: number }) => {
      if (isAppChat(chatId)) throw new Error("Telegram doesn't know app chats")
      telegram.push({ method: "sendMessage", chatId, text, threadId: opts?.message_thread_id })
      return { message_id: 1 }
    },
  } as unknown as Api
  const create = (key: ChatKey) => {
    const id = `ses_${++sessions}`
    store.set(key, id)
    return id
  }
  const bridge = {
    openThread: async (key: ChatKey) => create(key),
    sessionFor: async (key: ChatKey) => store.get(key)?.sessionID ?? create(key),
    resetSession: async (key: ChatKey) => create(key),
    prompt: async (sessionID: string, text: string) => void prompts.push({ sessionID, text }),
    subscribe: () => () => {},
    onResync: () => () => {},
    interrupt: async () => {},
  } as unknown as Bridge
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: "x" })
  questions = new Questions({ reply: async () => {} }, () => 10)
  chats = new Chats(api, bridge, store, config, undefined, () => ({ has_topics_enabled: true }) as never, questions, {
    check: async (id: number) => void checked.push(id),
  })
  chats.onPrompt = (id, source) => void sources.push([id, source])
  chats.appNotice = async (key, html) => void notices.push({ key, html })
})

afterEach(() => {
  questions.dispose()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const thijmen = { id: 42, is_bot: false, first_name: "Thijmen" } as User

describe("conversations from the app", () => {
  test("someone on Telegram gets a topic there, and app messages are echoed into it", async () => {
    store.seePerson(42, "Thijmen", null)
    const { key, sessionID } = await chats.startFromApp(42)
    expect(key).toEqual({ chatId: 42, threadId: topics })
    expect(telegram.map((t) => t.method)).toEqual(["createForumTopic", "sendMessage"])
    expect(telegram[1]!.text).toContain("started in the app")

    await chats.sendFromApp(sessionID, 42, "Wat eten we vanavond?")
    expect(telegram[2]).toMatchObject({ method: "sendMessage", chatId: 42, threadId: topics })
    expect(telegram[2]!.text).toContain("Wat eten we vanavond?")
    expect(prompts).toEqual([{ sessionID, text: "Wat eten we vanavond?" }])
    expect(sources).toEqual([[sessionID, "app"]])
    expect(checked).toEqual([42])
    expect(store.get(key)?.userId).toBe(42)
  })

  test("someone without Telegram stays out of Telegram entirely", async () => {
    const sanne = store.createAppPerson("Sanne")
    const first = await chats.startFromApp(sanne.id)
    const second = await chats.startFromApp(sanne.id)
    expect(first.key).toEqual({ chatId: sanne.appChatId!, threadId: 1 })
    expect(second.key).toEqual({ chatId: sanne.appChatId!, threadId: 2 })

    await chats.sendFromApp(first.sessionID, sanne.id, "Hoi")
    expect(prompts).toEqual([{ sessionID: first.sessionID, text: "Hoi" }])
    expect(telegram).toEqual([])
    expect(store.conversationsOf(sanne.id)).toHaveLength(2)
    await expect(chats.view(first.key)).rejects.toThrow(/only exists in the app/)
  })

  test("notices and scheduled runs in app-only chats become pushes", async () => {
    const sanne = store.createAppPerson("Sanne")
    const chat = sanne.appChatId!
    await chats.post({ chatId: chat, threadId: 0 }, "⏭ Skipped")
    const quiet = await chats.openScheduled(chat, "⏰ Boodschappen", "ses_run", "⏰ <b>Boodschappen</b>")
    const revealed = await chats.openScheduled(chat, "⏰ Boodschappen", "ses_run2", "⏰ <b>Boodschappen</b>", async () => {
      throw new Error("prefaces post to Telegram; not for app chats")
    })
    expect(quiet).toEqual({ chatId: chat, threadId: 1 })
    expect(revealed).toEqual({ chatId: chat, threadId: 2 })
    expect(store.get(quiet)?.sessionID).toBe("ses_run")
    expect(notices.map((n) => n.html)).toEqual(["⏭ Skipped", "⏰ <b>Boodschappen</b>"])
    expect(telegram).toEqual([])

    await chats.post({ chatId: 42, threadId: 0 }, "hi")
    expect(telegram).toEqual([{ method: "sendMessage", chatId: 42, text: "hi", threadId: undefined }])
  })

  test("a typed message answers an open question instead of prompting", async () => {
    const sanne = store.createAppPerson("Sanne")
    const { sessionID } = await chats.startFromApp(sanne.id)
    chats.questions.open(sessionID, "form1", [{ key: "q", title: "Wanneer?", question: "", multiple: false, options: [{ label: "Zaterdag" }] }])
    await chats.sendFromApp(sessionID, sanne.id, "Zondag")
    expect(prompts).toEqual([])
    expect(chats.questions.pending(sessionID)).toBeUndefined()
  })
})

describe("Telegram messages", () => {
  test("are attributed to the sender's person", async () => {
    await chats.send({ chatId: 42, threadId: 7 }, "hoi", [], thijmen)
    expect(checked).toEqual([42])
    expect(store.get({ chatId: 42, threadId: 7 })?.userId).toBe(42)
    expect(store.person(42)).toMatchObject({ telegramId: 42, name: "Thijmen" })
    expect(sources.map(([, s]) => s)).toEqual(["telegram"])
  })
})
