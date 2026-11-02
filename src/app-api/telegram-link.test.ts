import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Update } from "grammy/types"
import { telegramLinkCommand } from "../app-commands"
import { createBot } from "../bot"
import type { Chats } from "../chats"
import { loadConfig } from "../config"
import type { Bridge } from "../opencode"
import { Store } from "../store"
import { LINK_START, LinkError, TelegramLinks } from "./telegram-link"

let dir: string
let store: Store
let allowed: number[]
let username: string | null
let links: TelegramLinks

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "link-"))
  store = new Store(dir)
  allowed = []
  username = "HuubBot"
  links = new TelegramLinks({ store, botUsername: () => username, allow: (id) => void (allowed.includes(id) || allowed.push(id)) })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const codeOf = (url: string) => LINK_START.exec(`/start ${new URL(url).searchParams.get("start")}`)?.[1] ?? ""
const thijmen = { id: 42, name: "Thijmen", username: "thijmen" }

describe("Telegram links", () => {
  test("a link opens the bot with a one-time start code", () => {
    const sanne = store.createAppPerson("Sanne")
    const { url, expiresAt } = links.create(sanne.id, 1000)
    expect(url).toMatch(/^https:\/\/t\.me\/HuubBot\?start=link_[A-Za-z0-9_-]{16}$/)
    expect(`/start ${new URL(url).searchParams.get("start")}`.length).toBeLessThan(64 + 7)
    expect(expiresAt).toBe(1000 + 15 * 60_000)
    expect(codeOf(url)).not.toBe("")
  })

  test("redeeming makes the app person and the Telegram user one, and lets them use the bot", () => {
    const app = store.createAppPerson("Thijmen")
    store.addDevice({ id: "d1", personId: app.id, tokenHash: "h", name: null, platform: null })
    store.seePerson(42, "Thijmen", "thijmen")
    store.addMemory(42, "Drinks oat milk", "agent")

    const person = links.redeem(codeOf(links.create(app.id).url), thijmen)

    expect(person).toMatchObject({ id: 42, telegramId: 42, appChatId: app.appChatId })
    expect(store.device("d1")?.personId).toBe(42)
    expect(store.memories(42).length).toBe(1)
    expect(allowed).toEqual([42])
  })

  test("works for someone who never wrote to the bot before", () => {
    const app = store.createAppPerson("Sanne")
    const person = links.redeem(codeOf(links.create(app.id).url), { id: 7, name: "Sanne", username: null })
    expect(person).toMatchObject({ id: 7, telegramId: 7, name: "Sanne", appChatId: app.appChatId })
    expect(allowed).toEqual([7])
  })

  test("a code works once and expires", () => {
    const app = store.createAppPerson("Sanne")
    const code = codeOf(links.create(app.id, 0).url)
    expect(() => links.redeem(code, thijmen, 15 * 60_000)).toThrow("expired or was already used")
    const fresh = codeOf(links.create(app.id).url)
    links.redeem(fresh, thijmen)
    expect(() => links.redeem(fresh, thijmen)).toThrow("expired or was already used")
  })

  test("one Telegram account per person", () => {
    const app = store.createAppPerson("Sanne")
    const first = codeOf(links.create(app.id).url)
    const second = codeOf(links.create(app.id).url)
    links.redeem(first, thijmen)
    expect(() => links.create(42)).toThrow(LinkError)
    expect(() => links.create(42)).toThrow("already linked")
    // An older code moved along with the app person, who has Telegram now.
    expect(() => links.redeem(second, { id: 9, name: "Bram", username: null })).toThrow("already linked to another Telegram account")
    expect(store.personByTelegram(9)).toBeUndefined()
  })

  test("stops checking codes after too many wrong ones", () => {
    for (let i = 0; i < 5; i++) expect(() => links.redeem(`wrong-code-${i}-xxxxxxxx`, thijmen)).toThrow("expired")
    const app = store.createAppPerson("Sanne")
    expect(() => links.redeem(codeOf(links.create(app.id).url), thijmen)).toThrow("Too many tries")
  })

  test("needs the bot to be connected", () => {
    username = null
    expect(() => links.create(store.createAppPerson("Sanne").id)).toThrow("isn't connected to Telegram")
  })
})

describe("the bot's link command", () => {
  function bot() {
    const replies: string[] = []
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: "1:x", ALLOWED_USER_IDS: "1" })
    const b = createBot(config, {} as Bridge, () => ({}) as Chats, undefined, telegramLinkCommand({ links }))
    b.botInfo = { id: 1, is_bot: true, first_name: "Huub", username: "HuubBot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } as typeof b.botInfo
    b.api.config.use(async (_prev, method, payload) => {
      if (method === "sendMessage") replies.push((payload as { text: string }).text)
      return { ok: true, result: true } as never
    })
    return { b, replies }
  }

  const message = (text: string, from = 42): Update => ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: from, type: "private", first_name: "Thijmen" },
      from: { id: from, is_bot: false, first_name: "Thijmen" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  })

  test("links someone who isn't on the allowlist yet", async () => {
    const { b, replies } = bot()
    const app = store.createAppPerson("Thijmen")
    await b.handleUpdate(message(`/start link_${codeOf(links.create(app.id).url)}`))
    expect(replies.at(-1)).toContain("🔗 Linked! You're Thijmen in the HuubHuub app too.")
    expect(store.person(42)?.appChatId).toBe(app.appChatId)
    expect(allowed).toEqual([42])

    await b.handleUpdate(message(`/start link_${"x".repeat(16)}`))
    expect(replies.at(-1)).toContain("expired or was already used")
  })

  test("anything else still needs the allowlist", async () => {
    const { b, replies } = bot()
    await b.handleUpdate(message("/start"))
    expect(replies.at(-1)).toContain("Not authorised")
    await b.handleUpdate(message("/start link_short"))
    expect(replies.length).toBe(1)
  })
})
