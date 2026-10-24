import { createSign, randomBytes } from "node:crypto"
import { SkillError } from "./skills"
import type { Store } from "./store"

const API = "https://api.github.com"
const SETTING = "github_app"
const STATE_TTL_MS = 10 * 60_000
/** Installation tokens live an hour; renew a little early so a clone never starts with a dying token. */
const TOKEN_MARGIN_MS = 5 * 60_000
const LIST_TTL_MS = 60_000

/** What a new app asks for: enough for the agent to push branches, open PRs and work on issues. */
export const APP_PERMISSIONS: Record<string, "read" | "write"> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
  actions: "read",
  checks: "read",
}

interface Credentials {
  id: number
  slug: string
  name: string
  owner: string
  ownerType: "User" | "Organization"
  htmlUrl: string
  pem: string
}

export interface GitHubAppInfo {
  id: number
  slug: string
  name: string
  owner: string
  htmlUrl: string
  installUrl: string
  settingsUrl: string
}

export interface InstalledRepo {
  repo: string
  installationId: number
  defaultBranch: string
  private: boolean
}

/** One account (user or organization) the app is installed on. */
export interface Installation {
  id: number
  account: string
  accountType: "User" | "Organization"
  /** What the account granted, e.g. `{ contents: "write" }`. Lags behind the app until the owner accepts new permissions. */
  permissions: Record<string, string>
  repositorySelection: "all" | "selected"
  htmlUrl: string
  suspended: boolean
}

/** The bot user GitHub creates for the app; commits authored as it link to the app. */
export interface AppIdentity {
  name: string
  email: string
}

export class GitHubError extends SkillError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The GitHub App the bot uses for skill repos and for the agent's `gh` and `git`. It's created from the
 * admin UI with the manifest flow; its private key signs JWTs that are exchanged for short-lived installation tokens.
 */
export class GitHubApp {
  private readonly states = new Map<string, number>()
  private readonly tokens = new Map<number, { token: string; expires: number }>()
  private cache = new Map<string, { at: number; value: unknown }>()

  constructor(
    private readonly store: Store,
    private readonly http: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  connected(): boolean {
    return this.credentials() !== undefined
  }

  info(): GitHubAppInfo | null {
    const c = this.credentials()
    if (!c) return null
    const settingsUrl =
      c.ownerType === "Organization" ? `https://github.com/organizations/${c.owner}/settings/apps/${c.slug}` : `https://github.com/settings/apps/${c.slug}`
    return { id: c.id, slug: c.slug, name: c.name, owner: c.owner, htmlUrl: c.htmlUrl, installUrl: `https://github.com/apps/${c.slug}/installations/new`, settingsUrl }
  }

  /** The form the browser posts to GitHub to create the app. GitHub sends the browser back to `origin` with a code. */
  startManifest(origin: string, name?: string, org?: string): { action: string; manifest: Record<string, unknown> } {
    let base: URL
    try {
      base = new URL(origin)
    } catch {
      throw new SkillError("Invalid origin.")
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new SkillError("Invalid origin.")
    const appName = name?.trim() || `huub-${randomBytes(2).toString("hex")}`
    if (appName.length > 34) throw new SkillError("GitHub App names can be at most 34 characters.")
    const owner = org?.trim()
    if (owner && !/^[A-Za-z0-9-]+$/.test(owner)) throw new SkillError(`"${owner}" isn't a GitHub organization name.`)

    const now = this.now()
    for (const [s, expires] of this.states) if (expires < now) this.states.delete(s)
    const state = randomBytes(16).toString("hex")
    this.states.set(state, now + STATE_TTL_MS)

    const home = base.origin
    const action = owner
      ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${state}`
      : `https://github.com/settings/apps/new?state=${state}`
    return {
      action,
      manifest: {
        name: appName,
        url: home,
        redirect_url: `${home}/?github=created`,
        setup_url: `${home}/?github=installed`,
        setup_on_update: true,
        public: false,
        default_permissions: APP_PERMISSIONS,
      },
    }
  }

  /** Finish the manifest flow: trade the one-time code for the app's ID and private key. */
  async convert(code: string, state: string): Promise<GitHubAppInfo> {
    const expires = this.states.get(state)
    this.states.delete(state)
    if (!expires || expires < this.now()) throw new SkillError("This GitHub App setup expired. Start again from the GitHub page.")
    if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new SkillError("Invalid code from GitHub.")
    const app = await this.request<{
      id: number
      slug: string
      name: string
      html_url: string
      pem: string
      owner: { login: string; type: string }
    }>("POST", `/app-manifests/${code}/conversions`)
    this.store.setSetting(
      SETTING,
      JSON.stringify({
        id: app.id,
        slug: app.slug,
        name: app.name,
        owner: app.owner.login,
        ownerType: app.owner.type === "Organization" ? "Organization" : "User",
        htmlUrl: app.html_url,
        pem: app.pem,
      } satisfies Credentials),
    )
    this.tokens.clear()
    this.cache.clear()
    return this.info()!
  }

  disconnect(): void {
    this.store.setSetting(SETTING, undefined)
    this.tokens.clear()
    this.cache.clear()
  }

  /** A JWT that authenticates as the app itself, valid for 9 minutes. */
  jwt(): string {
    const c = this.required()
    const now = Math.floor(this.now() / 1000)
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: c.id })}`
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(c.pem, "base64url")}`
  }

  /** An installation access token, cached until shortly before it expires. `minValidMs` asks for one that lasts at least that long. */
  async token(installationId: number, minValidMs = TOKEN_MARGIN_MS): Promise<string> {
    const cached = this.tokens.get(installationId)
    if (cached && cached.expires - minValidMs > this.now()) return cached.token
    const res = await this.request<{ token: string; expires_at: string }>("POST", `/app/installations/${installationId}/access_tokens`, this.jwt())
    this.tokens.set(installationId, { token: res.token, expires: Date.parse(res.expires_at) })
    return res.token
  }

  /** Every account the app is installed on, refreshed at most once a minute. */
  installations(fresh = false): Promise<Installation[]> {
    return this.cached("installations", fresh, async () => {
      const list = await this.request<
        {
          id: number
          account: { login: string; type: string } | null
          permissions: Record<string, string>
          repository_selection: "all" | "selected"
          html_url: string
          suspended_at: string | null
        }[]
      >("GET", "/app/installations?per_page=100", this.jwt())
      return list.map((i) => ({
        id: i.id,
        account: i.account?.login ?? String(i.id),
        accountType: i.account?.type === "Organization" ? ("Organization" as const) : ("User" as const),
        permissions: i.permissions ?? {},
        repositorySelection: i.repository_selection,
        htmlUrl: i.html_url,
        suspended: Boolean(i.suspended_at),
      }))
    })
  }

  /** The permissions the app itself asks for, as set in its settings on GitHub. */
  permissions(fresh = false): Promise<Record<string, string>> {
    return this.cached("permissions", fresh, async () => (await this.request<{ permissions?: Record<string, string> }>("GET", "/app", this.jwt())).permissions ?? {})
  }

  /** The `slug[bot]` user commits are authored as. Its noreply address needs the bot user's ID. */
  async identity(): Promise<AppIdentity> {
    const c = this.required()
    const login = `${c.slug}[bot]`
    const user = await this.cached(`identity:${c.slug}`, false, () => this.request<{ id: number }>("GET", `/users/${encodeURIComponent(login)}`), Infinity)
    return { name: login, email: `${user.id}+${login}@users.noreply.github.com` }
  }

  /** The installation that covers `owner/repo`, or `null` if the app isn't installed there. */
  async installationFor(repo: string): Promise<number | null> {
    try {
      return (await this.request<{ id: number }>("GET", `/repos/${repo}/installation`, this.jwt())).id
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null
      throw err
    }
  }

  /** Every repo the app can read, across all its installations. */
  async repositories(): Promise<InstalledRepo[]> {
    const installations = await this.installations(true)
    const out: InstalledRepo[] = []
    for (const { id, suspended } of installations) {
      if (suspended) continue
      const token = await this.token(id)
      for (let page = 1; ; page++) {
        const res = await this.request<{ repositories: { full_name: string; default_branch: string; private: boolean }[] }>(
          "GET",
          `/installation/repositories?per_page=100&page=${page}`,
          token,
        )
        for (const r of res.repositories) out.push({ repo: r.full_name, installationId: id, defaultBranch: r.default_branch, private: r.private })
        if (res.repositories.length < 100) break
      }
    }
    return out.sort((a, b) => a.repo.localeCompare(b.repo))
  }

  private async request<T>(method: string, path: string, bearer?: string): Promise<T> {
    let res: Response
    try {
      res = await this.http(`${API}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "opencode-telegram-bot",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      })
    } catch (err) {
      throw new GitHubError(0, `Can't reach GitHub: ${err instanceof Error ? err.message : String(err)}`)
    }
    const body = (await res.json().catch(() => ({}))) as { message?: string }
    if (!res.ok) throw new GitHubError(res.status, `GitHub: ${body.message ?? res.statusText}`)
    return body as T
  }

  private async cached<T>(key: string, fresh: boolean, load: () => Promise<T>, ttl = LIST_TTL_MS): Promise<T> {
    const hit = this.cache.get(key)
    if (hit && !fresh && this.now() - hit.at < ttl) return hit.value as T
    const value = await load()
    this.cache.set(key, { at: this.now(), value })
    return value
  }

  private credentials(): Credentials | undefined {
    const raw = this.store.getSetting(SETTING)
    return raw ? (JSON.parse(raw) as Credentials) : undefined
  }

  private required(): Credentials {
    const c = this.credentials()
    if (!c) throw new SkillError("Connect the GitHub App on the GitHub page first.")
    return c
  }
}
