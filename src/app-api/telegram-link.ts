import { createHash, randomBytes } from "node:crypto"
import type { Person, Store } from "../store"

export const LINK_TTL_MS = 15 * 60_000
const FAIL_WINDOW_MS = 15 * 60_000
const MAX_FAILS = 5

/** What a `t.me/<bot>?start=link_<code>` link makes Telegram send, and nothing else. */
export const LINK_START = /^\/start(?:@\w+)? link_([A-Za-z0-9_-]{16,40})$/

export class LinkError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface TelegramUser {
  id: number
  name: string | null
  username: string | null
}

/**
 * Linking a Telegram account to someone who uses the app. The app asks for a one-time deep link to the bot;
 * opening it in Telegram sends the code, and the bot makes the app person and the Telegram user one person.
 */
export class TelegramLinks {
  private fails = new Map<number, number[]>()

  constructor(
    private readonly d: {
      store: Store
      /** The bot's @username, once it's connected to Telegram. */
      botUsername: () => string | null | undefined
      /** Let a newly linked Telegram user talk to the bot. */
      allow: (telegramId: number) => void
    },
  ) {}

  /** A one-time link for the person's phone to open in Telegram. */
  create(personId: number, now = Date.now()): { url: string; expiresAt: number } {
    const person = this.d.store.person(personId)
    if (!person) throw new LinkError(404, "Sign in again: this phone's person doesn't exist anymore.")
    if (person.telegramId !== null) throw new LinkError(409, "You're already linked to Telegram.")
    const username = this.d.botUsername()
    if (!username) throw new LinkError(503, "The server isn't connected to Telegram right now. Try again in a minute.")
    const code = randomBytes(12).toString("base64url")
    const expiresAt = now + LINK_TTL_MS
    this.d.store.addTelegramLink(hash(code), personId, expiresAt, now)
    return { url: `https://t.me/${username}?start=link_${code}`, expiresAt }
  }

  /** Someone opened a link in Telegram. Returns the person they are now, or throws a message for them. */
  redeem(code: string, user: TelegramUser, now = Date.now()): Person {
    if (this.blocked(user.id, now)) throw new LinkError(429, "⚠️ Too many tries. Wait a few minutes, then make a new link in the app.")
    const personId = this.d.store.takeTelegramLink(hash(code), now)
    const appPerson = personId === undefined ? undefined : this.d.store.person(personId)
    if (!appPerson) {
      this.failed(user.id, now)
      throw new LinkError(410, "⚠️ That link has expired or was already used. Make a new one in the app.")
    }
    if (appPerson.telegramId !== null && appPerson.telegramId !== user.id) {
      throw new LinkError(409, "⚠️ That app account is already linked to another Telegram account.")
    }
    const telegramPersonId = this.d.store.seePerson(user.id, user.name, user.username, now)
    const person = telegramPersonId === appPerson.id ? appPerson : this.d.store.mergePeople(appPerson.id, telegramPersonId)
    this.d.allow(user.id)
    return person
  }

  private blocked(userId: number, now: number): boolean {
    const recent = (this.fails.get(userId) ?? []).filter((t) => t > now - FAIL_WINDOW_MS)
    if (recent.length) this.fails.set(userId, recent)
    else this.fails.delete(userId)
    return recent.length >= MAX_FAILS
  }

  private failed(userId: number, now: number): void {
    this.fails.set(userId, [...(this.fails.get(userId) ?? []), now])
  }
}

function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}
