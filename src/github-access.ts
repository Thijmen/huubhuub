import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { APP_PERMISSIONS, type GitHubApp, type Installation } from "./github-app"
import type { Store } from "./store"

const DEFAULT_SETTING = "github_default_installation"
/** Tokens are minted per shell command; make sure even a long command doesn't outlive its token. */
const AGENT_TOKEN_VALID_MS = 20 * 60_000
const REMOTE_TTL_MS = 60_000
const LEVELS: Record<string, number> = { read: 1, write: 2, admin: 3 }

/** The git credential helper the agent's processes use for github.com. */
export const CREDENTIAL_HELPER = join(import.meta.dir, "..", "bin", "git-credential-bot")

export interface InstallationStatus extends Installation {
  /** Permissions the app asks for that this account hasn't granted (yet). */
  missing: string[]
  isDefault: boolean
}

/**
 * Gives the agent's `gh` and `git` access to GitHub through the app: installation tokens on demand,
 * and a git config (included by every agent process) that points github.com at the credential helper.
 */
export class GitHubAccess {
  readonly gitConfig: string
  private remotes = new Map<string, { owner: string | null; at: number }>()
  private gh?: Promise<string | null>

  constructor(
    private readonly app: GitHubApp,
    private readonly store: Store,
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.gitConfig = join(dataDir, "github", "gitconfig")
  }

  /** Rewrite the included git config. Without a connected app it's empty, so git behaves as usual. */
  async writeGitConfig(): Promise<void> {
    mkdirSync(dirname(this.gitConfig), { recursive: true })
    const info = this.app.info()
    if (!info) {
      writeFileSync(this.gitConfig, "# No GitHub App is connected.\n")
      return
    }
    const identity = await this.app.identity().catch((err) => {
      console.error("Couldn't look up the GitHub App's bot user; commits use its name without a linked email", err)
      return { name: `${info.slug}[bot]`, email: `${info.slug}[bot]@users.noreply.github.com` }
    })
    writeFileSync(this.gitConfig, gitConfigText(CREDENTIAL_HELPER, identity))
  }

  defaultInstallation(): number | null {
    const raw = this.store.getSetting(DEFAULT_SETTING)
    return raw ? Number(raw) : null
  }

  setDefaultInstallation(id: number | null): void {
    this.store.setSetting(DEFAULT_SETTING, id === null ? undefined : String(id))
  }

  /**
   * A token for the installation on `owner`, else on an account `command` names (like `gh repo clone acme/x`),
   * else on the owner of the repo checked out in `cwd`. Without a match it falls back to the default
   * installation, unless `strict`. A token only covers one account, so this picks the one the command needs.
   */
  async token(q: { owner?: string; command?: string; cwd?: string; strict?: boolean }): Promise<string | null> {
    if (!this.app.connected()) return null
    const list = (await this.app.installations()).filter((i) => !i.suspended)
    const owner =
      q.owner?.trim() ||
      (q.command ? mentionedAccount(q.command, list.map((i) => i.account)) : null) ||
      (q.cwd ? await this.ownerOf(q.cwd) : null)
    const match = owner ? list.find((i) => i.account.toLowerCase() === owner.toLowerCase()) : undefined
    const pick = match ?? (q.strict ? undefined : this.fallback(list))
    return pick ? this.app.token(pick.id, AGENT_TOKEN_VALID_MS) : null
  }

  async installations(): Promise<InstallationStatus[]> {
    const [list, wanted] = await Promise.all([this.app.installations(true), this.app.permissions(true)])
    const fallback = this.fallback(list.filter((i) => !i.suspended))
    return list.map((i) => ({ ...i, missing: missingPermissions(wanted, i.permissions), isDefault: i.id === fallback?.id }))
  }

  /** Recommended permissions the app itself doesn't ask for, e.g. because it was created read-only. */
  async missingAppPermissions(): Promise<string[]> {
    return missingPermissions(APP_PERMISSIONS, await this.app.permissions(true))
  }

  /** `gh --version`, or null when the GitHub CLI isn't installed. */
  ghVersion(): Promise<string | null> {
    this.gh ??= (async () => {
      const bin = Bun.which("gh")
      if (!bin) return null
      const out = Bun.spawnSync([bin, "--version"], { stderr: "ignore" }).stdout.toString()
      return /gh version (\S+)/.exec(out)?.[1] ?? "unknown"
    })()
    return this.gh
  }

  private fallback(list: Installation[]): Installation | undefined {
    const preferred = this.defaultInstallation()
    const owner = this.app.info()?.owner.toLowerCase()
    return list.find((i) => i.id === preferred) ?? list.find((i) => i.account.toLowerCase() === owner) ?? list[0]
  }

  private async ownerOf(cwd: string): Promise<string | null> {
    const hit = this.remotes.get(cwd)
    if (hit && this.now() - hit.at < REMOTE_TTL_MS) return hit.owner
    const proc = Bun.spawn(["git", "-C", cwd, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    const url = (await new Response(proc.stdout).text()).trim()
    const owner = (await proc.exited) === 0 ? githubOwner(url) : null
    this.remotes.set(cwd, { owner, at: this.now() })
    return owner
  }
}

/** The account a github.com remote URL points at. */
export function githubOwner(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\//.exec(url.trim())
  return m?.[1] ?? null
}

/**
 * The first of `accounts` a shell command names as a GitHub owner: `acme/repo`, `github.com/acme`,
 * `orgs/acme` or a bare `acme` argument. Path segments like `/home/acme/` don't count.
 */
export function mentionedAccount(command: string, accounts: string[]): string | null {
  let best: { account: string; at: number } | null = null
  for (const account of accounts) {
    if (!/^[A-Za-z0-9-]+$/.test(account)) continue
    const m = new RegExp(`(?:^|[\\s'"=:(]|github\\.com[/:]|\\b(?:repos|orgs|users)/)${account}(?![A-Za-z0-9-])`, "i").exec(command)
    if (m && (!best || m.index < best.at)) best = { account, at: m.index }
  }
  return best?.account ?? null
}

export function missingPermissions(wanted: Record<string, string>, granted: Record<string, string>): string[] {
  return Object.entries(wanted)
    .filter(([name, level]) => (LEVELS[granted[name] ?? ""] ?? 0) < (LEVELS[level] ?? 0))
    .map(([name, level]) => `${name}:${level}`)
}

/**
 * An empty `helper` clears helpers from the user's own config (say, a keychain), so github.com always
 * goes through the app. `useHttpPath` lets the helper see which owner a URL is for.
 */
export function gitConfigText(helper: string, identity: { name: string; email: string }): string {
  return [
    "# Written by the bot: the agent's git talks to github.com as the GitHub App.",
    '[credential "https://github.com"]',
    "\thelper =",
    `\thelper = !'${helper.replaceAll("'", "'\\''")}'`,
    "\tuseHttpPath = true",
    "[user]",
    `\tname = ${identity.name}`,
    `\temail = ${identity.email}`,
    "",
  ].join("\n")
}
