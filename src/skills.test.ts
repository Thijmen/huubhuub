import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseRepo, parseSkillFile, SkillError, SkillSources, type RepoAuth } from "./skills"
import { Store } from "./store"

const skillMd = (name: string, description = `Does ${name} things`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

describe("parseSkillFile", () => {
  test("reads name and description", () => {
    expect(parseSkillFile(skillMd("kdh"))).toEqual({ name: "kdh", description: "Does kdh things", error: null })
  })

  test("accepts folded descriptions and extra keys", () => {
    const parsed = parseSkillFile("---\nname: kdh\ndescription: >-\n  one\n  two\nlicense: MIT\nmetadata:\n  audience: me\n---\nbody")
    expect(parsed).toEqual({ name: "kdh", description: "one two", error: null })
  })

  test("requires frontmatter and a description", () => {
    expect(parseSkillFile("# no frontmatter").error).toContain("no frontmatter")
    expect(parseSkillFile("---\nname: x\n---\n").error).toContain("description")
    expect(parseSkillFile("---\nname: [unclosed\n---\n").error).toContain("Invalid frontmatter")
  })
})

describe("parseRepo", () => {
  test("accepts shorthand and GitHub URLs", () => {
    expect(parseRepo("Thijmen/huub-skills")).toBe("Thijmen/huub-skills")
    expect(parseRepo("https://github.com/Thijmen/huub-skills.git")).toBe("Thijmen/huub-skills")
    expect(parseRepo("github.com/Thijmen/huub-skills/")).toBe("Thijmen/huub-skills")
    expect(parseRepo("git@github.com:Thijmen/huub-skills.git")).toBe("Thijmen/huub-skills")
  })

  test("rejects anything else", () => {
    expect(() => parseRepo("https://gitlab.com/a/b")).toThrow(SkillError)
    expect(() => parseRepo("just-a-name")).toThrow(SkillError)
    expect(() => parseRepo("../etc")).toThrow(SkillError)
  })
})

describe("SkillSources", () => {
  let root: string
  let store: Store
  let alerts: string[]
  let remotes: Record<string, string>
  let skills: SkillSources
  /** A stand-in GitHub App: repo → installation id, plus which installations can mint tokens. */
  let installs: Record<string, number>
  let live: Set<number>
  let connected: boolean
  const github: RepoAuth = {
    connected: () => connected,
    installationFor: async (repo) => installs[repo] ?? null,
    token: async (id) => {
      if (!live.has(id)) throw new SkillError(`installation ${id} is gone`)
      return `token-${id}`
    },
  }

  const enabled = (id: string) => join(root, "data", "skills", "enabled", id)

  async function repo(name: string, files: Record<string, string>): Promise<string> {
    const dir = join(root, "remotes", name)
    mkdirSync(dir, { recursive: true })
    await $`git init -q -b main ${dir}`.quiet()
    await commit(dir, files)
    return dir
  }

  async function commit(dir: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    await $`git -C ${dir} add -A`.quiet()
    await $`git -C ${dir} -c user.name=t -c user.email=t@t commit -q -m update`.quiet()
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-test-"))
    store = new Store(join(root, "data"))
    alerts = []
    remotes = {}
    installs = new Proxy({} as Record<string, number>, { get: (t, k: string) => (k in t ? t[k] : k in remotes ? 1 : undefined) })
    live = new Set([1])
    connected = true
    skills = new SkillSources(store, join(root, "data"), () => 0, github, (r) => remotes[r] ?? join(root, "missing"))
    skills.onAlert = (html) => alerts.push(html)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  test("clones a repo and links every valid skill", async () => {
    remotes["acme/skills"] = await repo("a", { "skills/kdh/SKILL.md": skillMd("kdh"), "skills/broken/SKILL.md": "no frontmatter", "README.md": "hi" })
    const view = await skills.add({ repo: "acme/skills" })
    expect(view.lastCommit).toBeTruthy()
    expect(view.skills.map((s) => [s.id, s.status])).toEqual([
      ["broken", "error"],
      ["kdh", "enabled"],
    ])
    expect(lstatSync(enabled("kdh")).isSymbolicLink()).toBe(true)
    expect(readlinkSync(enabled("kdh"))).toEndWith(join("repos", "acme-skills", "skills", "kdh"))
    expect(existsSync(enabled("broken"))).toBe(false)
  })

  test("refuses a repo the app isn't installed on and saves nothing", async () => {
    await expect(skills.add({ repo: "acme/nope" })).rejects.toThrow("isn't installed on acme/nope")
    expect(skills.list()).toEqual([])
  })

  test("refuses to add anything before the app is connected", async () => {
    remotes["acme/skills"] = await repo("a", { "kdh/SKILL.md": skillMd("kdh") })
    connected = false
    await expect(skills.add({ repo: "acme/skills" })).rejects.toThrow("Connect the GitHub App")
  })

  test("follows the repo to a new installation after a reinstall", async () => {
    remotes["acme/skills"] = await repo("a", { "kdh/SKILL.md": skillMd("kdh") })
    await skills.add({ repo: "acme/skills" })
    live = new Set([2])
    installs["acme/skills"] = 2
    await skills.sync("acme-skills")
    expect(skills.get("acme-skills").lastError).toBeNull()
    expect(store.skillSource("acme-skills")!.installationId).toBe(2)
  })

  test("says so when the app lost access or was disconnected", async () => {
    remotes["acme/skills"] = await repo("a", { "kdh/SKILL.md": skillMd("kdh") })
    await skills.add({ repo: "acme/skills" })
    live = new Set()
    installs["acme/skills"] = null as unknown as number
    await skills.sync("acme-skills")
    expect(skills.get("acme-skills").lastError).toBe("The GitHub App isn't installed on acme/skills anymore.")
    connected = false
    await skills.sync("acme-skills")
    expect(skills.get("acme-skills").lastError).toContain("isn't connected")
    expect(existsSync(enabled("kdh"))).toBe(true)
    expect(alerts).toHaveLength(1)
  })

  test("refuses an unknown branch", async () => {
    remotes["acme/skills"] = await repo("a", { "kdh/SKILL.md": skillMd("kdh") })
    await expect(skills.add({ repo: "acme/skills", ref: "nope" })).rejects.toThrow('no branch or tag "nope"')
  })

  test("toggles link and unlink a skill", async () => {
    remotes["acme/skills"] = await repo("a", { "kdh/SKILL.md": skillMd("kdh") })
    await skills.add({ repo: "acme/skills" })
    expect(skills.setEnabled("acme-skills", "kdh", false).skills[0]!.status).toBe("disabled")
    expect(existsSync(enabled("kdh"))).toBe(false)
    skills.setEnabled("acme-skills", "kdh", true)
    expect(existsSync(enabled("kdh"))).toBe(true)
  })

  test("a skill id another source already provides is rejected", async () => {
    remotes["acme/one"] = await repo("one", { "kdh/SKILL.md": skillMd("kdh") })
    remotes["acme/two"] = await repo("two", { "kdh/SKILL.md": skillMd("kdh"), "other/SKILL.md": skillMd("other") })
    await skills.add({ repo: "acme/one" })
    const two = await skills.add({ repo: "acme/two" })
    expect(two.skills.find((s) => s.id === "kdh")).toMatchObject({ status: "error", error: '"kdh" is already provided by acme/one.' })
    expect(readlinkSync(enabled("kdh"))).toContain("acme-one")
    expect(existsSync(enabled("other"))).toBe(true)
  })

  test("sync picks up new commits", async () => {
    const dir = await repo("a", { "kdh/SKILL.md": skillMd("kdh") })
    remotes["acme/skills"] = dir
    const first = await skills.add({ repo: "acme/skills" })
    await commit(dir, { "new/SKILL.md": skillMd("new") })
    await skills.sync("acme-skills")
    const after = skills.get("acme-skills")
    expect(after.lastCommit).not.toBe(first.lastCommit)
    expect(after.skills.map((s) => s.id)).toEqual(["kdh", "new"])
    expect(existsSync(enabled("new"))).toBe(true)
  })

  test("a failed sync keeps the skills loaded and alerts once, then on recovery", async () => {
    const dir = await repo("a", { "kdh/SKILL.md": skillMd("kdh") })
    remotes["acme/skills"] = dir
    await skills.add({ repo: "acme/skills" })
    // Break the checkout's remote the way a revoked token or deleted repo would.
    await $`git -C ${join(root, "data", "skills", "repos", "acme-skills")} remote set-url origin ${join(root, "missing")}`.quiet()

    await skills.sync()
    await skills.sync()
    const failed = skills.get("acme-skills")
    expect(failed.lastError).toBeTruthy()
    expect(store.skillSource("acme-skills")!.failStreak).toBe(2)
    expect(existsSync(enabled("kdh"))).toBe(true)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain("stay loaded")

    await $`git -C ${join(root, "data", "skills", "repos", "acme-skills")} remote set-url origin ${dir}`.quiet()
    await skills.sync()
    expect(skills.get("acme-skills").lastError).toBeNull()
    expect(alerts).toHaveLength(2)
    expect(alerts[1]).toContain("syncing again")
  })

  test("remove unlinks the skills and deletes the checkout", async () => {
    remotes["acme/skills"] = await repo("a", { "kdh/SKILL.md": skillMd("kdh") })
    await skills.add({ repo: "acme/skills" })
    skills.setEnabled("acme-skills", "kdh", false)
    await skills.remove("acme-skills")
    expect(existsSync(enabled("kdh"))).toBe(false)
    expect(existsSync(join(root, "data", "skills", "repos", "acme-skills"))).toBe(false)
    expect(store.skillStates().size).toBe(0)
    expect(skills.list()).toEqual([])
  })
})
