import { describe, expect, test } from "bun:test"
import { isRelease, needsNewApk, type AppRelease } from "./app-release"

const release: AppRelease = { versionCode: 5, version: "0.1.0", fingerprint: "new", url: "https://github.com/x/y/releases/download/app-android/huubhuub.apk" }

describe("needsNewApk", () => {
  test("a newer build with other native code needs installing", () => {
    expect(needsNewApk(release, { versionCode: 3, runtimeVersion: "old" })).toBe(true)
  })

  test("the same native code gets over-the-air updates instead", () => {
    expect(needsNewApk(release, { versionCode: 3, runtimeVersion: "new" })).toBe(false)
  })

  test("this build or an older one doesn't count, nor does an unknown own version", () => {
    expect(needsNewApk(release, { versionCode: 5, runtimeVersion: "old" })).toBe(false)
    expect(needsNewApk(release, { versionCode: 6, runtimeVersion: "old" })).toBe(false)
    expect(needsNewApk(release, { versionCode: null, runtimeVersion: "old" })).toBe(false)
  })
})

test("isRelease only accepts what CI publishes", () => {
  expect(isRelease(release)).toBe(true)
  expect(isRelease({ ...release, url: "javascript:alert(1)" })).toBe(false)
  expect(isRelease({ ...release, versionCode: "5" })).toBe(false)
  expect(isRelease(null)).toBe(false)
})
