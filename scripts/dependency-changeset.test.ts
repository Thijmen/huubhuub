import { describe, expect, test } from "bun:test"
import { changesetContent, productionDepsChanged, ships } from "./dependency-changeset"

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ name: "huubhuub", dependencies: deps, devDependencies: dev }, null, 2)

const none = { base: null, head: null }

describe("ships", () => {
  test("a production dependency update ships", () => {
    const base = pkg({ grammy: "^1.46.0" }, { "@types/bun": "latest" })
    const head = pkg({ grammy: "^1.47.0" }, { "@types/bun": "latest" })
    expect(ships(["package.json", "bun.lock"], { base, head })).toBe(true)
  })

  test("a dev dependency update doesn't", () => {
    const base = pkg({ grammy: "^1.46.0" }, { "@changesets/cli": "^3.0.3" })
    const head = pkg({ grammy: "^1.46.0" }, { "@changesets/cli": "^3.1.0" })
    expect(ships(["package.json", "bun.lock"], { base, head })).toBe(false)
  })

  test("lock file maintenance ships, since it may touch production dependencies", () => {
    expect(ships(["bun.lock"], none)).toBe(true)
  })

  test("the Dockerfile ships; Actions, Renovate's config and docker-compose don't", () => {
    expect(ships(["Dockerfile"], none)).toBe(true)
    expect(ships([".github/workflows/ci.yml"], none)).toBe(false)
    expect(ships(["renovate.json", "docker-compose.yml"], none)).toBe(false)
  })
})

test("productionDepsChanged ignores key order", () => {
  expect(productionDepsChanged(pkg({ a: "1", b: "2" }), pkg({ b: "2", a: "1" }))).toBe(false)
  expect(productionDepsChanged(pkg({ a: "1" }), pkg({ a: "1", b: "2" }))).toBe(true)
})

test("changesetContent", () => {
  expect(changesetContent(true, "Update dependency grammy to v1.47.0")).toBe(
    `---\n"huubhuub": patch\n---\n\nUpdate dependency grammy to v1.47.0\n`,
  )
  expect(changesetContent(false, "Update actions/checkout action to v8")).toBe(`---\n---\n\nUpdate actions/checkout action to v8\n`)
})
