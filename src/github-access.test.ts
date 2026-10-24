import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CREDENTIAL_HELPER, GitHubAccess, githubOwner, gitConfigText, missingPermissions } from "./github-access"
import type { GitHubApp, Installation } from "./github-app"
import { InternalApi } from "./internal"
import { Store } from "./store"

function installation(id: number, account: string, extra: Partial<Installation> = {}): Installation {
  return { id, account, accountType: "User", permissions: { contents: "write" }, repositorySelection: "all", htmlUrl: "", suspended: false, ...extra }
}

class FakeApp {
  connectedFlag = true
  owner = "Thijmen"
  list: Installation[] = []
  minted: { id: number; minValid: number | undefined }[] = []
  connected() {
    return this.connectedFlag
  }
  info() {
    return this.connectedFlag ? { id: 1, slug: "huub-x", name: "huub-x", owner: this.owner, htmlUrl: "", installUrl: "", settingsUrl: "" } : null
  }
  async installations() {
    return this.list
  }
  async permissions() {
    return { contents: "write", pull_requests: "write", issues: "write", metadata: "read" }
  }
  async token(id: number, minValid?: number) {
    this.minted.push({ id, minValid })
    return `tok-${id}`
  }
  async identity() {
    return { name: "huub-x[bot]", email: "5+huub-x[bot]@users.noreply.github.com" }
  }
}

let dir: string
let store: Store
let app: FakeApp
let access: GitHubAccess

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gh-access-"))
  store = new Store(dir)
  app = new FakeApp()
  access = new GitHubAccess(app as unknown as GitHubApp, store, dir)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("GitHubAccess", () => {
  test("hands out the token of the installation on the repo's owner", async () => {
    app.list = [installation(1, "Thijmen"), installation(2, "acme")]
    expect(await access.token({ owner: "ACME" })).toBe("tok-2")
    expect(app.minted.at(-1)!.minValid).toBeGreaterThanOrEqual(15 * 60_000)
  })

  test("falls back to the default installation, then the app owner's, unless strict", async () => {
    app.list = [installation(2, "acme"), installation(1, "Thijmen")]
    expect(await access.token({ owner: "someone-else" })).toBe("tok-1")
    expect(await access.token({})).toBe("tok-1")
    access.setDefaultInstallation(2)
    expect(await access.token({})).toBe("tok-2")
    expect(await access.token({ owner: "someone-else", strict: true })).toBeNull()
  })

  test("skips suspended installations and gives nothing without an app", async () => {
    app.list = [installation(1, "Thijmen", { suspended: true })]
    expect(await access.token({ owner: "Thijmen" })).toBeNull()
    app.connectedFlag = false
    expect(await access.token({})).toBeNull()
  })

  test("reads the owner from the checkout's origin remote", async () => {
    app.list = [installation(1, "Thijmen"), installation(2, "acme")]
    const repo = join(dir, "repo")
    await Bun.$`git init -q ${repo} && git -C ${repo} remote add origin https://github.com/acme/widgets.git`.quiet()
    expect(await access.token({ cwd: repo, strict: true })).toBe("tok-2")
    expect(await access.token({ cwd: dir, strict: true })).toBeNull()
  })

  test("flags permissions an installation hasn't granted", async () => {
    app.list = [installation(1, "Thijmen", { permissions: { contents: "read", metadata: "read", issues: "write", pull_requests: "admin" } })]
    const [i] = await access.installations()
    expect(i!.missing).toEqual(["contents:write"])
    expect(i!.isDefault).toBe(true)
  })

  test("writes an empty git config without an app and a credential helper with one", async () => {
    app.connectedFlag = false
    await access.writeGitConfig()
    expect(readFileSync(access.gitConfig, "utf8")).not.toContain("helper")
    app.connectedFlag = true
    await access.writeGitConfig()
    const text = readFileSync(access.gitConfig, "utf8")
    expect(text).toContain(CREDENTIAL_HELPER)
    expect(text).toContain("email = 5+huub-x[bot]@users.noreply.github.com")
  })

  test("git gets the app's token through the included config and the credential helper", async () => {
    app.list = [installation(1, "Thijmen"), installation(2, "acme")]
    await access.writeGitConfig()
    const internal = new InternalApi()
    internal.attach({ github: access, schedules: {} as never })
    try {
      const env: Record<string, string | undefined> = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_NOSYSTEM: "1", ...internal.env(access.gitConfig) }
      // An editor's askpass (VS Code sets one) would answer instead of failing.
      delete env.GIT_ASKPASS
      delete env.SSH_ASKPASS
      const fill = async (path: string) => {
        const proc = Bun.spawn(["git", "credential", "fill"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
        proc.stdin.write(`protocol=https\nhost=github.com\npath=${path}\n\n`)
        await proc.stdin.end()
        const out = await new Response(proc.stdout).text()
        const fields = Object.fromEntries(out.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
        return { code: await proc.exited, fields }
      }
      const acme = (await fill("acme/widgets.git")).fields
      expect(acme.username).toBe("x-access-token")
      expect(acme.password).toBe("tok-2")
      expect((await fill("Thijmen/x.git")).fields.password).toBe("tok-1")
      // No installation there: the helper stays quiet and git, unable to prompt, gives up.
      expect((await fill("stranger/x.git")).code).not.toBe(0)
      expect((await Bun.$`git config user.name`.env(env).text()).trim()).toBe("huub-x[bot]")
    } finally {
      internal.stop()
    }
  })
})

describe("helpers", () => {
  test("githubOwner understands https, ssh and scp-style remotes", () => {
    expect(githubOwner("https://github.com/acme/widgets.git")).toBe("acme")
    expect(githubOwner("https://x-access-token:abc@github.com/acme/widgets")).toBe("acme")
    expect(githubOwner("git@github.com:acme/widgets.git")).toBe("acme")
    expect(githubOwner("ssh://git@github.com/acme/widgets.git")).toBe("acme")
    expect(githubOwner("https://gitlab.com/acme/widgets.git")).toBeNull()
  })

  test("missingPermissions compares access levels", () => {
    expect(missingPermissions({ contents: "write", metadata: "read" }, { contents: "admin" })).toEqual(["metadata:read"])
  })

  test("the helper path is quoted for the shell", () => {
    expect(gitConfigText("/a b/it's", { name: "n", email: "e" })).toContain(`helper = !'/a b/it'\\''s'`)
  })
})
