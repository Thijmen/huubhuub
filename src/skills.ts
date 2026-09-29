import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { GitHubApp } from "./github-app"
import type { SkillSource, Store } from "./store"

const GIT_TIMEOUT_MS = 120_000
const TICK_MS = 60_000

export interface SkillInfo {
  /** The directory name; OpenCode uses it as the skill's id. */
  id: string
  name: string
  description: string | null
  /** Path of the skill directory relative to the repo root. */
  path: string
  status: "enabled" | "disabled" | "error"
  error: string | null
}

export interface SkillSourceView {
  id: string
  repo: string
  ref: string | null
  lastSyncAt: number | null
  lastCommit: string | null
  lastError: string | null
  syncing: boolean
  /** Whether a checkout exists; before the first successful sync there are no skills. */
  checkedOut: boolean
  skills: SkillInfo[]
}

interface Scanned {
  id: string
  name: string
  description: string | null
  dir: string
  path: string
  error: string | null
}

export class SkillError extends Error {}

type Git = (args: string[], token: string, cwd?: string) => Promise<string>
/** What the sync needs from the GitHub App. */
export type RepoAuth = Pick<GitHubApp, "connected" | "token" | "installationFor">

/**
 * Git repositories of skills, managed from the admin UI. Each source is cloned into
 * `DATA_DIR/skills/repos/<id>`; every enabled skill is symlinked into `DATA_DIR/skills/enabled`,
 * which is the only skills path OpenCode is given. OpenCode watches that directory and reloads on change.
 */
export class SkillSources {
  readonly enabledDir: string
  private readonly reposDir: string
  private readonly running = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private lastAuto = 0
  /** HTML messages about failing and recovering sources, for the allowlisted users. */
  onAlert: (html: string) => void = () => {}

  constructor(
    private readonly store: Store,
    dataDir: string,
    private readonly intervalMinutes: () => number,
    private readonly github: RepoAuth,
    private readonly remote: (repo: string) => string = (repo) => `https://github.com/${repo}.git`,
    private readonly git: Git = runGit,
  ) {
    this.enabledDir = join(dataDir, "skills", "enabled")
    this.reposDir = join(dataDir, "skills", "repos")
    mkdirSync(this.enabledDir, { recursive: true })
    mkdirSync(this.reposDir, { recursive: true })
  }

  list(): SkillSourceView[] {
    return this.resolve().map(({ source, skills }) => ({
      id: source.id,
      repo: source.repo,
      ref: source.ref,
      lastSyncAt: source.lastSyncAt,
      lastCommit: source.lastCommit,
      lastError: source.lastError,
      syncing: this.running.has(source.id),
      checkedOut: existsSync(this.checkout(source.id)),
      skills: skills.map(({ dir: _, ...s }) => s),
    }))
  }

  get(id: string): SkillSourceView {
    const view = this.list().find((s) => s.id === id)
    if (!view) throw new SkillError(`No skill source ${id}.`)
    return view
  }

  /** Check the app can read the repo (and the ref exists), save the source and pull it. Throws `SkillError` otherwise. */
  async add(input: { repo: string; ref?: string | null }): Promise<SkillSourceView> {
    const repo = parseRepo(input.repo)
    const ref = input.ref?.trim() || null
    const id = sourceId(repo)
    if (this.store.skillSource(id)) throw new SkillError(`${repo} is already added.`)
    if (!this.github.connected()) throw new SkillError("Connect the GitHub App first.")
    const installationId = await this.github.installationFor(repo)
    if (!installationId) throw new SkillError(`The GitHub App isn't installed on ${repo}. Install it on that repo first.`)
    await this.check(repo, ref, await this.github.token(installationId))
    this.store.createSkillSource({ id, repo, ref, installationId })
    await this.sync(id)
    return this.get(id)
  }

  /** Switch the branch or tag. */
  async update(id: string, input: { ref?: string | null }): Promise<SkillSourceView> {
    const source = this.source(id)
    const ref = input.ref === undefined ? source.ref : input.ref?.trim() || null
    await this.check(source.repo, ref, await this.tokenFor(source))
    this.store.updateSkillSource(id, { ref })
    await this.sync(id)
    return this.get(id)
  }

  async remove(id: string): Promise<void> {
    this.source(id)
    await this.running.get(id)
    this.store.deleteSkillSource(id)
    this.reconcile()
    rmSync(this.checkout(id), { recursive: true, force: true })
  }

  setEnabled(id: string, skillId: string, enabled: boolean): SkillSourceView {
    const skill = this.get(id).skills.find((s) => s.id === skillId)
    if (!skill) throw new SkillError(`No skill ${skillId} in this source.`)
    this.store.setSkillEnabled(id, skillId, enabled)
    this.reconcile()
    return this.get(id)
  }

  /** Pull one source, or all of them in order. Failures are recorded on the source; this never throws. */
  async sync(id?: string): Promise<void> {
    if (id === undefined) {
      for (const s of this.store.skillSources()) await this.sync(s.id)
      return
    }
    const pending = this.running.get(id)
    if (pending) return pending
    const run = this.pull(id).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  /** Pull every source on `SKILL_SYNC_INTERVAL_MINUTES`; the interval is read on every tick so changes apply live. */
  start(): void {
    this.lastAuto = Date.now()
    this.timer = setInterval(() => {
      const minutes = this.intervalMinutes()
      if (minutes <= 0 || Date.now() - this.lastAuto < minutes * 60_000) return
      this.lastAuto = Date.now()
      void this.sync()
    }, TICK_MS)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  private async pull(id: string): Promise<void> {
    const source = this.store.skillSource(id)
    if (!source) return
    try {
      const commit = await this.pullCheckout(source, await this.tokenFor(source))
      this.store.updateSkillSource(id, { lastSyncAt: Date.now(), lastCommit: commit, lastError: null, failStreak: 0 })
      this.reconcile(id)
      if (source.failStreak > 0) this.onAlert(`✅ Skills from <b>${escape(source.repo)}</b> are syncing again.`)
    } catch (err) {
      if (!this.store.skillSource(id)) return
      const message = await this.explain(source, err)
      console.error(`Skill source ${source.repo} failed to sync: ${message}`)
      this.store.updateSkillSource(id, { lastError: message, failStreak: source.failStreak + 1 })
      this.reconcile()
      if (source.failStreak === 0) {
        const kept = existsSync(this.checkout(id)) ? "The skills from the last successful sync stay loaded." : "Its skills aren't loaded until a sync works."
        this.onAlert(`⚠️ Couldn't sync skills from <b>${escape(source.repo)}</b>: ${escape(message)}\n${kept}`)
      }
    }
  }

  /** Clone or update the checkout; returns the short commit. */
  private async pullCheckout(source: SkillSource, token: string): Promise<string> {
    const dir = this.checkout(source.id)
    if (!existsSync(join(dir, ".git"))) {
      const staging = join(this.reposDir, `.${source.id}.tmp`)
      rmSync(staging, { recursive: true, force: true })
      try {
        await this.git(["clone", "--depth", "1", ...(source.ref ? ["--branch", source.ref] : []), this.remote(source.repo), staging], token)
        rmSync(dir, { recursive: true, force: true })
        renameSync(staging, dir)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    } else {
      await this.git(["fetch", "--depth", "1", "origin", source.ref ?? "HEAD"], token, dir)
      await this.git(["reset", "--hard", "FETCH_HEAD"], token, dir)
      await this.git(["clean", "-fdx"], token, dir)
    }
    return (await this.git(["rev-parse", "--short", "HEAD"], token, dir)).trim()
  }

  /**
   * An installation token for the source's repo. If the installation is gone (the app was reinstalled,
   * or a new app connected), look it up again once.
   */
  private async tokenFor(source: SkillSource): Promise<string> {
    if (!this.github.connected()) throw new SkillError("The GitHub App isn't connected. Connect it on the Skills page.")
    if (source.installationId !== null) {
      try {
        return await this.github.token(source.installationId)
      } catch (err) {
        const fresh = await this.github.installationFor(source.repo)
        if (fresh === source.installationId) throw err
        if (fresh !== null) {
          this.store.updateSkillSource(source.id, { installationId: fresh })
          return this.github.token(fresh)
        }
      }
    }
    const installationId = await this.github.installationFor(source.repo)
    if (installationId === null) throw new SkillError(`The GitHub App isn't installed on ${source.repo} anymore.`)
    this.store.updateSkillSource(source.id, { installationId })
    return this.github.token(installationId)
  }

  /** Git just says "repository not found" when the app lost access; say why when we can tell. */
  private async explain(source: SkillSource, err: unknown): Promise<string> {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof SkillError || !this.github.connected()) return message
    const installed = await this.github.installationFor(source.repo).catch(() => undefined)
    return installed === null ? `The GitHub App isn't installed on ${source.repo} anymore.` : message
  }

  private async check(repo: string, ref: string | null, token: string): Promise<void> {
    try {
      const out = await this.git(["ls-remote", this.remote(repo), ref ?? "HEAD"], token)
      if (!out.trim()) throw new SkillError(ref ? `${repo} has no branch or tag "${ref}".` : `${repo} is empty.`)
    } catch (err) {
      if (err instanceof SkillError) throw err
      throw new SkillError(`Can't reach ${repo}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Every source with its skills, deciding which are linked. The first source to ship a skill id owns it. */
  private resolve(): { source: SkillSource; skills: (SkillInfo & { dir: string })[] }[] {
    const states = this.store.skillStates()
    const owners = new Map<string, string>()
    return this.store.skillSources().map((source) => {
      const skills = scanSkills(this.checkout(source.id), source.repo).map((s) => {
        let error = s.error
        const owner = owners.get(s.id)
        if (!error && owner) error = `"${s.id}" is already provided by ${owner}.`
        if (!error) owners.set(s.id, source.repo)
        const enabled = states.get(`${source.id}/${s.id}`) ?? true
        const status: SkillInfo["status"] = error ? "error" : enabled ? "enabled" : "disabled"
        return { id: s.id, name: s.name, description: s.description, path: s.path, status, error, dir: s.dir }
      })
      return { source, skills }
    })
  }

  /**
   * Make `enabled/` match the enabled skills. Links of `refresh` are recreated so OpenCode's watcher
   * notices content that changed inside a checkout.
   */
  private reconcile(refresh?: string): void {
    const wanted = new Map<string, { dir: string; source: string }>()
    for (const { source, skills } of this.resolve()) {
      for (const s of skills) if (s.status === "enabled") wanted.set(s.id, { dir: s.dir, source: source.id })
    }
    for (const name of readdirSync(this.enabledDir)) {
      const link = join(this.enabledDir, name)
      if (!lstatSync(link).isSymbolicLink()) continue
      const want = wanted.get(name)
      if (want && want.source !== refresh && readlinkSync(link) === want.dir) wanted.delete(name)
      else unlinkSync(link)
    }
    for (const [name, { dir }] of wanted) symlinkSync(dir, join(this.enabledDir, name), "dir")
  }

  private source(id: string): SkillSource {
    const source = this.store.skillSource(id)
    if (!source) throw new SkillError(`No skill source ${id}.`)
    return source
  }

  private checkout(id: string): string {
    return join(this.reposDir, id)
  }
}

/** Accepts `owner/repo`, `github.com/owner/repo` and GitHub HTTPS/SSH URLs; returns `owner/repo`. */
export function parseRepo(input: string): string {
  const trimmed = input
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com[/:]/, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
  const parts = trimmed.split("/")
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== ".."))
    throw new SkillError(`"${input.trim()}" isn't a GitHub repo. Use owner/repo or https://github.com/owner/repo.`)
  return trimmed
}

export function sourceId(repo: string): string {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

/** Every `SKILL.md` below `root`, parsed the way OpenCode reads it. */
export function scanSkills(root: string, repo: string): Scanned[] {
  if (!existsSync(root)) return []
  const files = [...new Bun.Glob("**/SKILL.md").scanSync({ cwd: root, dot: false, followSymlinks: false })].sort()
  const seen = new Set<string>()
  return files.map((file) => {
    const rel = dirname(file)
    const dir = join(root, rel)
    const id = rel === "." ? basename(repo) : basename(rel)
    const parsed = parseSkillFile(readFileSync(join(root, file), "utf8"))
    let error = parsed.error
    if (!error && seen.has(id)) error = `Another skill in this repo is also called "${id}".`
    seen.add(id)
    return { id, name: parsed.name ?? id, description: parsed.description, dir, path: rel === "." ? "" : rel, error }
  })
}

export function parseSkillFile(text: string): { name: string | null; description: string | null; error: string | null } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return { name: null, description: null, error: "SKILL.md has no frontmatter (a --- block with name and description)." }
  let data: unknown
  try {
    data = Bun.YAML.parse(match[1]!)
  } catch (err) {
    return { name: null, description: null, error: `Invalid frontmatter: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { name: null, description: null, error: "The frontmatter must be key: value pairs." }
  const fm = data as Record<string, unknown>
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : null
  const description = typeof fm.description === "string" && fm.description.trim() ? fm.description.trim() : null
  if (fm.name !== undefined && typeof fm.name !== "string") return { name, description, error: "name must be text." }
  if (!description) return { name, description, error: "The frontmatter needs a description, so the agent knows when to use the skill." }
  return { name, description, error: null }
}

/** Run git non-interactively as the GitHub App installation. The token goes in an HTTP header through the environment, so it never lands in argv or `.git/config`. */
async function runGit(args: string[], token: string, cwd?: string): Promise<string> {
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: header,
      // Don't fall back to (or store into) credentials of whoever runs the bot.
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) {
    const lines = err.split("\n").map((l) => l.trim()).filter(Boolean)
    const errors = lines.filter((l) => /^(fatal|error|remote):/.test(l)).map((l) => l.replace(/^(fatal|error):\s*/, ""))
    let detail = (errors.length ? errors : lines).slice(-2).join(" ") || (proc.signalCode ? "git timed out" : `git exited with ${code}`)
    if (token.length >= 8) detail = detail.replaceAll(token, "••••")
    throw new Error(detail)
  }
  return out
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
