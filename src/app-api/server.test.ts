import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Chats } from "../chats"
import { loadConfig } from "../config"
import type { Bridge, SessionEvent } from "../opencode"
import { Questions } from "../question"
import { SpendLimitError } from "../spend-limits"
import { Store } from "../store"
import { AppAccess } from "./access"
import type { AppEvent, ConversationList, ConversationPage, Me, PairResponse } from "./protocol"
import { AppPush } from "./push"
import { startAppApi } from "./server"

let dir: string
let store: Store
let server: ReturnType<typeof startAppApi>
let base: string
const listeners = new Map<string, (e: SessionEvent) => void>()
const sent: { sessionID: string; personId: number; text: string }[] = []
const interrupted: string[] = []
let blocked = false

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "app-api-"))
  store = new Store(dir)
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: "x", APP_PORT: "0", APP_HOST: "127.0.0.1", APP_PUBLIC_URL: "https://huub.example.com" })
  const bridge = {
    host: {
      message: {
        list: async ({ sessionID }: { sessionID: string }) => ({
          data: [
            { id: "a1", type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "text", text: `Antwoord in ${sessionID}` }] },
            { id: "u1", type: "user", text: "Vraag", time: { created: 1 } },
          ],
          cursor: {},
        }),
      },
      session: { active: async () => ({ ses_busy: {} }) },
    },
    getSession: async (id: string) => ({ title: `Titel ${id}` }),
    subscribe: (id: string, fn: (e: SessionEvent) => void) => {
      listeners.set(id, fn)
      return () => listeners.delete(id)
    },
    interrupt: async (id: string) => void interrupted.push(id),
    transcript: async () => [],
  } as unknown as Bridge
  const questions = new Questions({ reply: async () => {} }, () => 10)
  const chats = {
    startFromApp: async (personId: number) => {
      const chatId = store.appChatOf(personId)
      const key = { chatId, threadId: store.nextAppThread(chatId) }
      const sessionID = `ses_new_${key.threadId}`
      store.set(key, sessionID)
      return { key, sessionID }
    },
    sendFromApp: async (sessionID: string, personId: number, text: string) => {
      if (blocked) throw new SpendLimitError("⛔ Limit reached.")
      sent.push({ sessionID, personId, text })
    },
  } as unknown as Chats
  const access = new AppAccess(store, () => config.APP_PUBLIC_URL)
  const push = new AppPush({ store, bridge, send: async () => [] })
  server = startAppApi({ config, store, bridge, chats, questions, access, push, voice: false, serverName: () => "Huub" })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (path: string, init: Omit<RequestInit, "body"> & { token?: string; body?: unknown } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })

async function signIn(personId: number): Promise<string> {
  const code = new AppAccess(store, () => "https://huub.example.com").invite(personId).url.split("#")[1]
  const res = await call("/v1/pair", { method: "POST", body: { code, deviceName: "Pixel", platform: "android" } })
  expect(res.status).toBe(200)
  return ((await res.json()) as PairResponse).token
}

describe("app API", () => {
  test("pairing, and only with a valid invite", async () => {
    expect((await call("/v1/pair", { method: "POST", body: { code: "nope" } })).status).toBe(403)
    const sanne = store.createAppPerson("Sanne")
    const token = await signIn(sanne.id)
    const me = (await (await call("/v1/me", { token })).json()) as Me
    expect(me).toMatchObject({ person: { id: sanne.id, name: "Sanne" }, device: { name: "Pixel" }, serverName: "Huub", features: { voice: false, telegram: false } })
    expect((await call("/v1/me")).status).toBe(401)
    expect((await call("/v1/me", { token: "wrong" })).status).toBe(401)
  })

  test("a person sees and uses only their own conversations", async () => {
    const sanne = store.createAppPerson("Sanne 2")
    const other = store.createAppPerson("Bram")
    const token = await signIn(sanne.id)
    store.set({ chatId: store.appChatOf(other.id), threadId: 1 }, "ses_bram")
    store.seePerson(42, "Thijmen", null)
    store.set({ chatId: 42, threadId: 3 }, "ses_thijmen")

    const created = await call("/v1/conversations", { method: "POST", token, body: { text: "Hoi Huub" } })
    expect(created.status).toBe(200)
    const conv = (await created.json()) as { id: string; telegram: boolean }
    expect(conv).toMatchObject({ id: "ses_new_1", telegram: false, title: "Titel ses_new_1", preview: "Antwoord in ses_new_1" })
    expect(sent.at(-1)).toEqual({ sessionID: "ses_new_1", personId: sanne.id, text: "Hoi Huub" })

    const list = (await (await call("/v1/conversations", { token })).json()) as ConversationList
    expect(list.conversations.map((c) => c.id)).toEqual(["ses_new_1"])

    const page = (await (await call("/v1/conversations/ses_new_1", { token })).json()) as ConversationPage
    expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(page).toMatchObject({ older: null, question: null, conversation: { id: "ses_new_1", busy: false } })

    for (const id of ["ses_bram", "ses_thijmen", "nope"]) {
      expect((await call(`/v1/conversations/${id}`, { token })).status).toBe(404)
      expect((await call(`/v1/conversations/${id}/messages`, { method: "POST", token, body: { text: "x" } })).status).toBe(404)
    }

    expect((await call("/v1/conversations/ses_new_1/messages", { method: "POST", token, body: { text: "  " } })).status).toBe(400)
    blocked = true
    const refused = await call("/v1/conversations/ses_new_1/messages", { method: "POST", token, body: { text: "Nog eentje" } })
    blocked = false
    expect(refused.status).toBe(402)
    expect(await refused.json()).toEqual({ error: "⛔ Limit reached." })

    expect((await call("/v1/conversations/ses_new_1/stop", { method: "POST", token })).status).toBe(200)
    expect(interrupted).toEqual(["ses_new_1"])
  })

  test("a Telegram user's private topics show up, marked as Telegram", async () => {
    store.seePerson(43, "Thijmen", null)
    store.set({ chatId: 43, threadId: 9 }, "ses_busy")
    const token = await signIn(43)
    const list = (await (await call("/v1/conversations", { token })).json()) as ConversationList
    expect(list.conversations).toEqual([{ id: "ses_busy", title: "Titel ses_busy", updatedAt: expect.any(Number), busy: true, preview: "Antwoord in ses_busy", telegram: true }])
  })

  test("live events in the app's format", async () => {
    const p = store.createAppPerson("Live")
    const token = await signIn(p.id)
    store.set({ chatId: store.appChatOf(p.id), threadId: 1 }, "ses_live")
    const res = await call("/v1/conversations/ses_live/events", { token })
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    const reader = res.body!.getReader()
    const next = async (): Promise<AppEvent> => {
      const { value } = await reader.read()
      return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "").trim())
    }
    expect(await next()).toEqual({ type: "ready" })
    listeners.get("ses_live")!({ type: "session.text.delta", data: { sessionID: "ses_live", assistantMessageID: "a", ordinal: 0, delta: "Hoi" } } as unknown as SessionEvent)
    expect(await next()).toEqual({ type: "text", messageId: "a", ordinal: 0, delta: "Hoi" })
    await reader.cancel()
  })

  test("push tokens and signing out", async () => {
    const p = store.createAppPerson("Push")
    const token = await signIn(p.id)
    expect((await call("/v1/devices/current/push", { method: "PUT", token, body: { token: "garbage" } })).status).toBe(400)
    expect((await call("/v1/devices/current/push", { method: "PUT", token, body: { token: "ExponentPushToken[abc]" } })).status).toBe(200)
    expect(store.devicesOf(p.id)[0]!.pushToken).toBe("ExponentPushToken[abc]")
    expect((await call("/v1/devices/current", { method: "DELETE", token })).status).toBe(200)
    expect((await call("/v1/me", { token })).status).toBe(401)
  })

  test("the invite page", async () => {
    const res = await call("/pair")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("huubhuub://pair?server=")
  })
})
