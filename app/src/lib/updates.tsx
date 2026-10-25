import * as Application from "expo-application"
import Constants from "expo-constants"
import * as Updates from "expo-updates"
import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { AppState } from "react-native"
import { isRelease, needsNewApk, type AppRelease } from "./app-release"

/** How often to look for an over-the-air update while the app is used. */
const CHECK_EVERY_MS = 20 * 60_000
/** A downloaded update is applied when the app comes back after being away this long, so it never reloads mid-sentence. */
const APPLY_AFTER_AWAY_MS = 5 * 60_000
/** How often to look for a new APK. */
const RELEASE_CHECK_EVERY_MS = 3 * 60 * 60_000

const OFFICIAL_PROJECT_ID = "025416eb-b7d3-4ca0-b1b1-d5b79a2dfe58"
const OFFICIAL_RELEASES = "https://github.com/Thijmen/huubhuub/releases/download/app-android/latest.json"

/**
 * Over-the-air updates, without anyone pressing a button: expo-updates downloads one when the app starts, and
 * this also looks again whenever the app comes back to the foreground. A downloaded update starts the next
 * time the app is opened after being away for a while (or on a cold start, which expo-updates handles).
 */
function useAutoUpdates(): void {
  const { isUpdatePending } = Updates.useUpdates()
  const pending = useRef(isUpdatePending)
  pending.current = isUpdatePending

  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return
    // expo-updates checks once at launch by itself.
    let checkedAt = Date.now()
    let awaySince: number | null = null
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") awaySince ??= Date.now()
      if (state !== "active") return
      const away = awaySince === null ? 0 : Date.now() - awaySince
      awaySince = null
      if (pending.current && away >= APPLY_AFTER_AWAY_MS) return void Updates.reloadAsync().catch(() => {})
      if (Date.now() - checkedAt < CHECK_EVERY_MS) return
      checkedAt = Date.now()
      void Updates.checkForUpdateAsync()
        .then((r) => (r.isAvailable ? Updates.fetchUpdateAsync() : undefined))
        .catch(() => {})
    })
    return () => sub.remove()
  }, [])
}

/** Where this build looks for new APKs: the official releases, or a fork's own (`EXPO_PUBLIC_APP_RELEASES`). */
export function releaseFeed(): string | null {
  const own = process.env.EXPO_PUBLIC_APP_RELEASES
  if (own) return own
  if (__DEV__) return null
  return Constants.expoConfig?.extra?.eas?.projectId === OFFICIAL_PROJECT_ID ? OFFICIAL_RELEASES : null
}

/** A newer APK this phone should install, if there is one. Looks when the app starts and now and then after. */
function useNewApk(): AppRelease | null {
  const [release, setRelease] = useState<AppRelease | null>(null)

  useEffect(() => {
    const feed = releaseFeed()
    if (!feed || process.env.EXPO_OS !== "android") return
    const own = { versionCode: Number(Application.nativeBuildVersion) || null, runtimeVersion: Updates.runtimeVersion ?? null }
    let checkedAt = 0
    const check = () => {
      if (Date.now() - checkedAt < RELEASE_CHECK_EVERY_MS) return
      checkedAt = Date.now()
      fetch(feed, { headers: { "cache-control": "no-cache" } })
        .then((r) => (r.ok ? r.json() : null))
        .then((r: unknown) => setRelease(isRelease(r) && needsNewApk(r, own) ? r : null))
        .catch(() => {})
    }
    check()
    const sub = AppState.addEventListener("change", (s) => s === "active" && check())
    return () => sub.remove()
  }, [])

  return release
}

interface UpdatesValue {
  /** A newer APK to install. */
  apk: AppRelease | null
  /** Its card on the conversation list was put off until the app starts again. */
  putOff: boolean
  later: () => void
}

const UpdatesContext = createContext<UpdatesValue>({ apk: null, putOff: false, later: () => {} })

/** Keeps the app up to date while it runs, and knows about new APKs. */
export function UpdatesProvider({ children }: { children: ReactNode }) {
  useAutoUpdates()
  const apk = useNewApk()
  const [putOff, setPutOff] = useState<number | null>(null)
  const value = useMemo(() => ({ apk, putOff: apk !== null && apk.versionCode === putOff, later: () => setPutOff(apk?.versionCode ?? null) }), [apk, putOff])
  return <UpdatesContext value={value}>{children}</UpdatesContext>
}

export function useAppUpdate(): UpdatesValue {
  return use(UpdatesContext)
}
