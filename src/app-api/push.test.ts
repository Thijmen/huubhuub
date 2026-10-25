import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "../opencode"
import { APP_ID_BASE, type AppDevice, type ChatState } from "../store"
import { AppPush, type PushMessage } from "./push"

const APP_CHAT = APP_ID_BASE
const PERSON = APP_ID_BASE

function setup(threads: Record<string, Pick<ChatState, "chatId" | "threadId">>) {
  const sent: PushMessage[] = []
  const dropped: string[] = []
  const devices: AppDevice[] = [{ id: "d", personId: PERSON, name: null, platform: "android", pushToken: "ExponentPushToken[ok]", createdAt: 0, seenAt: 0 }]
  const push = new AppPush({
    store: {
      get: (key) => {
        const hit = Object.entries(threads).find(([, t]) => t.chatId === key.chatId && t.threadId === key.threadId)
        return hit ? ({ ...hit[1], sessionID: hit[0] } as ChatState) : undefined
      },
      bySession: (id) => (threads[id] ? ({ ...threads[id], sessionID: id } as ChatState) : undefined),
      ownerOfChat: (chatId) => (chatId === APP_CHAT || chatId === 42 ? PERSON : null),
      devicesOf: () => devices,
      dropPushToken: (t) => void dropped.push(t),
    },
    bridge: {
      getSession: async () => ({ title: "Weekendje Texel" }) as never,
      transcript: async () => [
        { kind: "text", text: "Eerst even zoeken." },
        { kind: "text", text: "**Texel** is een goed idee: neem de boot vanuit Den Helder." },
      ],
    },
    send: async (messages) => {
      sent.push(...messages)
      return messages.map((m) => (m.to === "ExponentPushToken[gone]" ? { status: "error" as const, message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok" as const, id: "1" }))
    },
  })
  return { push, sent, dropped, devices }
}

const done = (sessionID: string) => ({ type: "session.execution.succeeded", data: { sessionID } }) as unknown as SessionEvent

describe("AppPush", () => {
  test("pushes the end of the reply for app-only conversations", async () => {
    const { push, sent } = setup({ app: { chatId: APP_CHAT, threadId: 1 } })
    await push.onEvent(done("app"))
    expect(sent).toEqual([
      { to: "ExponentPushToken[ok]", title: "Weekendje Texel", body: "Texel is een goed idee: neem de boot vanuit Den Helder.", data: { conversationId: "app" }, sound: "default", channelId: "replies" },
    ])
  })

  test("Telegram conversations only push for prompts sent from the app", async () => {
    const { push, sent } = setup({ tg: { chatId: 42, threadId: 7 } })
    await push.onEvent(done("tg"))
    expect(sent).toHaveLength(0)
    push.onPrompt("tg", "app")
    await push.onEvent(done("tg"))
    expect(sent).toHaveLength(1)
    push.onPrompt("tg", "telegram")
    await push.onEvent(done("tg"))
    expect(sent).toHaveLength(1)
  })

  test("no push while a phone has the conversation open", async () => {
    const { push, sent } = setup({ app: { chatId: APP_CHAT, threadId: 1 } })
    const a = push.watch("app")
    const b = push.watch("app")
    await push.onEvent(done("app"))
    a()
    a()
    await push.onEvent(done("app"))
    expect(sent).toHaveLength(0)
    b()
    await push.onEvent(done("app"))
    expect(sent).toHaveLength(1)
  })

  test("questions and failures push too; dead tokens are dropped", async () => {
    const { push, sent, dropped, devices } = setup({ app: { chatId: APP_CHAT, threadId: 1 } })
    devices.push({ ...devices[0]!, id: "e", pushToken: "ExponentPushToken[gone]" })
    await push.onEvent({ type: "form.created", data: { form: { sessionID: "app", metadata: { kind: "question" }, fields: [{ title: "Datum", description: "Welk weekend?" }] } } } as unknown as SessionEvent)
    await push.onEvent({ type: "session.execution.failed", data: { sessionID: "app", error: { message: "No credit" } } } as unknown as SessionEvent)
    expect(sent.map((m) => m.body)).toEqual(["❓ Welk weekend?", "❓ Welk weekend?", "⚠️ No credit", "⚠️ No credit"])
    expect(dropped).toEqual(["ExponentPushToken[gone]", "ExponentPushToken[gone]"])
  })

  test("notices in app-only chats", async () => {
    const { push, sent } = setup({ run: { chatId: APP_CHAT, threadId: 3 } })
    await push.notice({ chatId: APP_CHAT, threadId: 3 }, "⏰ <b>Boodschappen</b>\n<i>Wat moet ik halen?</i>")
    expect(sent[0]).toMatchObject({ title: "HuubHuub", body: "⏰ Boodschappen Wat moet ik halen?", data: { conversationId: "run" } })
  })
})
