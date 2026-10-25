/** Pure checks for app releases, kept apart from the native modules so they can be tested. */

/** What CI publishes next to the newest APK (see .github/workflows/app.yml). */
export interface AppRelease {
  /** Android versionCode; goes up with every build. */
  versionCode: number
  version: string
  /** The build's native fingerprint, which is also its runtime version for over-the-air updates. */
  fingerprint: string
  /** The APK. */
  url: string
  size?: number
}

/**
 * Whether a published APK is newer than this one in a way an over-the-air update can't cover. Same
 * fingerprint means the same native code, so updates already reach this build.
 */
export function needsNewApk(release: AppRelease, own: { versionCode: number | null; runtimeVersion: string | null }): boolean {
  if (own.versionCode === null || !Number.isFinite(release.versionCode)) return false
  if (own.runtimeVersion && release.fingerprint === own.runtimeVersion) return false
  return release.versionCode > own.versionCode
}

export function isRelease(x: unknown): x is AppRelease {
  const r = x as Partial<AppRelease> | null
  return typeof r?.versionCode === "number" && typeof r.url === "string" && /^https?:\/\//.test(r.url) && typeof r.fingerprint === "string" && typeof r.version === "string"
}
