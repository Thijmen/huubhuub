import { createHash, randomBytes } from "node:crypto"
import type { AppDevice, Store } from "../store"

export const INVITE_TTL_MS = 24 * 60 * 60_000
const SEEN_EVERY_MS = 60_000

export class AccessError extends Error {}

/** Who may use the app: one-time invites, swapped for a device token that stays valid until revoked. */
export class AppAccess {
  constructor(
    private readonly store: Store,
    private readonly publicUrl: () => string | undefined,
  ) {}

  /** A one-time invite for a person. The link opens the invite page; the app reads the code from it. */
  invite(personId: number, now = Date.now()): { url: string; expiresAt: number } {
    const base = this.publicUrl()
    if (!base) throw new AccessError("Set APP_PUBLIC_URL to the address phones reach the app API on (behind TLS) before inviting anyone.")
    if (!this.store.person(personId)) throw new AccessError(`There's no person ${personId}.`)
    const code = randomBytes(16).toString("base64url")
    const expiresAt = now + INVITE_TTL_MS
    this.store.addInvite(hash(code), personId, expiresAt, now)
    return { url: inviteUrl(base, code), expiresAt }
  }

  /** Swap an invite code for a device token. Each code works once. */
  pair(code: string, name: string | null, platform: string | null, now = Date.now()): { token: string; device: AppDevice } {
    const personId = code ? this.store.takeInvite(hash(code), now) : undefined
    if (personId === undefined) throw new AccessError("This invite doesn't work (anymore). Ask for a new one.")
    const token = randomBytes(32).toString("base64url")
    const device = this.store.addDevice({ id: randomBytes(9).toString("base64url"), personId, tokenHash: hash(token), name, platform }, now)
    return { token, device }
  }

  /** The device behind an `Authorization: Bearer` header. */
  authenticate(header: string | null, now = Date.now()): AppDevice | undefined {
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : ""
    if (!token) return undefined
    const device = this.store.deviceByToken(hash(token))
    if (device && (device.seenAt ?? 0) < now - SEEN_EVERY_MS) this.store.touchDevice(device.id, now)
    return device
  }
}

/** `https://host/pair#<code>`: the code sits in the fragment, so it never reaches proxy or access logs. */
export function inviteUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, "")}/pair#${code}`
}

function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}
