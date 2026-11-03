import * as Updates from "expo-updates"
import { useEffect, useRef, type ReactNode } from "react"
import { AppState } from "react-native"

/** How often to look for an over-the-air update while the app is used. */
const CHECK_EVERY_MS = 20 * 60_000
/** A downloaded update is applied when the app comes back after being away this long, so it never reloads mid-sentence. */
const APPLY_AFTER_AWAY_MS = 5 * 60_000

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

/** Keeps the app up to date while it runs. New native versions come from Google Play, which updates the app itself. */
export function UpdatesProvider({ children }: { children: ReactNode }) {
  useAutoUpdates()
  return children
}
