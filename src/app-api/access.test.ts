import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APP_ID_BASE, isAppChat, Store } from "../store"
import { AccessError, AppAccess, INVITE_TTL_MS } from "./access"

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-access-"))
})

afterEach(() => {
  store?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("people across Telegram and the app", () => {
  test("existing people keep their Telegram ID as person ID", () => {
    const db = new Database(join(dir, "bot.sqlite"), { create: true })
    db.run("CREATE TABLE people (user_id INTEGER PRIMARY KEY, name TEXT, username TEXT, persona_id INTEGER, memory_mode TEXT, seen_at INTEGER)")
    db.run("INSERT INTO people (user_id, name) VALUES (42, 'Thijmen')")
    db.close()

    store = new Store(dir)
    expect(store.person(42)).toMatchObject({ id: 42, telegramId: 42, appChatId: null, name: "Thijmen" })
    expect(store.personByTelegram(42)?.id).toBe(42)
    expect(store.seePerson(42, "Thijmen S", "thijmen")).toBe(42)
  })

  test("app people get IDs Telegram never uses, and their own chat", () => {
    store = new Store(dir)
    const a = store.createAppPerson("Sanne")
    const b = store.createAppPerson("Bram")
    expect(a.id).toBe(APP_ID_BASE)
    expect(b.id).toBe(APP_ID_BASE + 1)
    expect(a).toMatchObject({ telegramId: null, appChatId: a.id })
    expect(isAppChat(a.appChatId!)).toBe(true)
    expect(store.ownerOfChat(a.appChatId!)).toBe(a.id)

    // A Telegram user who wants app-only conversations gets a fresh chat ID from the same range.
    store.seePerson(42, "Thijmen", null)
    const chat = store.appChatOf(42)
    expect(chat).toBe(APP_ID_BASE + 2)
    expect(store.appChatOf(42)).toBe(chat)
    expect(store.ownerOfChat(chat)).toBe(42)
    expect(store.ownerOfChat(42)).toBe(42)
    expect(store.ownerOfChat(-100123)).toBeNull()
  })

  test("someone who started in the app keeps their person when they write from Telegram", () => {
    store = new Store(dir)
    const sanne = store.createAppPerson("Sanne")
    // Linking happens later; simulate it directly.
    ;(store as unknown as { db: Database }).db.query("UPDATE people SET telegram_id = 77 WHERE user_id = ?").run(sanne.id)
    expect(store.seePerson(77, "Sanne", "sanne")).toBe(sanne.id)
    expect(store.ownerOfChat(77)).toBe(sanne.id)
    expect(store.person(77)).toBeUndefined()
  })

  test("conversations are a person's private chats only", () => {
    store = new Store(dir)
    store.seePerson(42, "Thijmen", null)
    const appChat = store.appChatOf(42)
    store.set({ chatId: 42, threadId: 5 }, "ses_tg")
    store.set({ chatId: appChat, threadId: store.nextAppThread(appChat) }, "ses_app")
    store.set({ chatId: -100, threadId: 1 }, "ses_group")
    store.touch({ chatId: -100, threadId: 1 }, 42)
    expect(store.nextAppThread(appChat)).toBe(2)
    expect(store.conversationsOf(42).map((t) => t.sessionID).sort()).toEqual(["ses_app", "ses_tg"])
    expect(store.conversationsOf(999)).toEqual([])
  })
})

describe("AppAccess", () => {
  test("an invite signs in one phone, once", () => {
    store = new Store(dir)
    const access = new AppAccess(store, () => "https://huub.example.com/")
    const sanne = store.createAppPerson("Sanne")
    const { url, expiresAt } = access.invite(sanne.id, 1000)
    expect(url).toStartWith("https://huub.example.com/pair#")
    expect(expiresAt).toBe(1000 + INVITE_TTL_MS)
    expect(store.openInvites(1000).get(sanne.id)).toBe(1)

    const code = url.split("#")[1]!
    const { token, device } = access.pair(code, "Pixel", "android", 2000)
    expect(device).toMatchObject({ personId: sanne.id, name: "Pixel", platform: "android", pushToken: null })
    expect(() => access.pair(code, "Other", null, 3000)).toThrow(AccessError)
    expect(store.openInvites(3000).size).toBe(0)

    expect(access.authenticate(`Bearer ${token}`)?.id).toBe(device.id)
    expect(access.authenticate(`Bearer ${token}x`)).toBeUndefined()
    expect(access.authenticate(null)).toBeUndefined()
    store.deleteDevice(device.id)
    expect(access.authenticate(`Bearer ${token}`)).toBeUndefined()
  })

  test("expired and unknown codes don't work", () => {
    store = new Store(dir)
    const access = new AppAccess(store, () => "https://x.test")
    const p = store.createAppPerson("P")
    const code = access.invite(p.id, 0).url.split("#")[1]!
    expect(() => access.pair(code, null, null, INVITE_TTL_MS + 1)).toThrow(AccessError)
    expect(() => access.pair("", null, null)).toThrow(AccessError)
    expect(() => access.pair("nope", null, null)).toThrow(AccessError)
  })

  test("inviting needs a public URL", () => {
    store = new Store(dir)
    const access = new AppAccess(store, () => undefined)
    expect(() => access.invite(store.createAppPerson("P").id)).toThrow(/APP_PUBLIC_URL/)
  })

  test("a push token belongs to one device", () => {
    store = new Store(dir)
    const p = store.createAppPerson("P")
    const a = store.addDevice({ id: "a", personId: p.id, tokenHash: "ha", name: null, platform: null })
    const b = store.addDevice({ id: "b", personId: p.id, tokenHash: "hb", name: null, platform: null })
    store.setPushToken(a.id, "ExponentPushToken[1]")
    store.setPushToken(b.id, "ExponentPushToken[1]")
    expect(store.devicesOf(p.id).map((d) => d.pushToken)).toEqual([null, "ExponentPushToken[1]"])
    store.dropPushToken("ExponentPushToken[1]")
    expect(store.devicesOf(p.id).every((d) => d.pushToken === null)).toBe(true)
  })
})
