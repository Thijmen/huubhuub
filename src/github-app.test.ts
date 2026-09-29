import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitHubApp } from "./github-app"
import { SkillError } from "./skills"
import { Store } from "./store"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString()

describe("GitHubApp", () => {
  let root: string
  let store: Store
  let now: number
  let calls: { method: string; url: string; auth?: string }[]
  let routes: Record<string, (n: number) => [number, unknown]>
  let app: GitHubApp

  const http = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET"
    const auth = (init.headers as Record<string, string>).authorization
    calls.push({ method, url, auth })
    const path = url.replace("https://api.github.com", "")
    const route = routes[`${method} ${path}`]
    const n = calls.filter((c) => c.method === method && c.url === url).length
    const [status, body] = route ? route(n) : [404, { message: "Not Found" }]
    return new Response(JSON.stringify(body), { status })
  }

  const connect = async () => {
    const { action } = app.startManifest("http://localhost:8080/some/page")
    const state = new URL(action).searchParams.get("state")!
    routes["POST /app-manifests/abc/conversions"] = () => [
      201,
      { id: 42, slug: "huub-skills-x", name: "huub-skills-x", html_url: "https://github.com/apps/huub-skills-x", pem, owner: { login: "Thijmen", type: "User" } },
    ]
    return app.convert("abc", state)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gh-app-test-"))
    store = new Store(root)
    now = Date.parse("2026-09-29T12:00:00Z")
    calls = []
    routes = {}
    app = new GitHubApp(store, http, () => now)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  test("builds a read-only manifest that returns to the admin origin", () => {
    const { action, manifest } = app.startManifest("https://bot.example.com/#skills", "my-app", "acme")
    expect(action).toStartWith("https://github.com/organizations/acme/settings/apps/new?state=")
    expect(manifest).toMatchObject({
      name: "my-app",
      redirect_url: "https://bot.example.com/?github=created",
      setup_url: "https://bot.example.com/?github=installed",
      public: false,
      default_permissions: { contents: "read", metadata: "read" },
    })
    expect(manifest).not.toHaveProperty("hook_attributes")
    expect(app.startManifest("http://localhost:8080").action).toStartWith("https://github.com/settings/apps/new?state=")
  })

  test("converts the manifest code once and stores the app", async () => {
    const info = await connect()
    expect(info).toMatchObject({ id: 42, slug: "huub-skills-x", owner: "Thijmen", installUrl: "https://github.com/apps/huub-skills-x/installations/new" })
    expect(app.connected()).toBe(true)
    expect(JSON.stringify(app.info())).not.toContain("PRIVATE KEY")
  })

  test("rejects an unknown, reused or expired state", async () => {
    await expect(app.convert("abc", "nope")).rejects.toThrow(SkillError)
    const state = new URL(app.startManifest("http://localhost:8080").action).searchParams.get("state")!
    now += 11 * 60_000
    await expect(app.convert("abc", state)).rejects.toThrow("expired")
    await expect(app.convert("abc", state)).rejects.toThrow("expired")
    expect(calls).toHaveLength(0)
  })

  test("signs an RS256 JWT for the app", async () => {
    await connect()
    const [header, payload, signature] = app.jwt().split(".")
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" })
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString())
    expect(claims).toEqual({ iss: 42, iat: now / 1000 - 60, exp: now / 1000 + 540 })
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature!, "base64url")).toBe(true)
  })

  test("caches installation tokens until shortly before they expire", async () => {
    await connect()
    routes["POST /app/installations/7/access_tokens"] = (n) => [201, { token: `tok-${n}`, expires_at: new Date(now + 60 * 60_000).toISOString() }]
    expect(await app.token(7)).toBe("tok-1")
    now += 50 * 60_000
    expect(await app.token(7)).toBe("tok-1")
    now += 6 * 60_000
    expect(await app.token(7)).toBe("tok-2")
    expect(calls.at(-1)!.auth).toStartWith("Bearer ey")
  })

  test("finds installations and lists their repos", async () => {
    await connect()
    routes["GET /repos/Thijmen/huub-skills/installation"] = () => [200, { id: 7 }]
    routes["GET /app/installations?per_page=100"] = () => [200, [{ id: 7 }]]
    routes["POST /app/installations/7/access_tokens"] = () => [201, { token: "tok", expires_at: new Date(now + 3_600_000).toISOString() }]
    routes["GET /installation/repositories?per_page=100&page=1"] = () => [
      200,
      { repositories: [{ full_name: "Thijmen/huub-skills", default_branch: "main", private: true }] },
    ]
    expect(await app.installationFor("Thijmen/huub-skills")).toBe(7)
    expect(await app.installationFor("Thijmen/other")).toBeNull()
    expect(await app.repositories()).toEqual([{ repo: "Thijmen/huub-skills", installationId: 7, defaultBranch: "main", private: true }])
    expect(calls.find((c) => c.url.includes("/installation/repositories"))!.auth).toBe("Bearer tok")
  })

  test("disconnect forgets the app", async () => {
    await connect()
    app.disconnect()
    expect(app.connected()).toBe(false)
    expect(() => app.jwt()).toThrow("Connect the GitHub App")
  })
})
