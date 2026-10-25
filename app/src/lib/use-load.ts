import { useFocusEffect } from "expo-router"
import { useCallback, useState } from "react"

/** Load something whenever the screen comes into view; `set` replaces it with what a change returned. */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    load()
      .then((d) => (setData(d), setError(null)))
      .catch((err: Error) => setError(err.message))
  }, [load])
  useFocusEffect(reload)
  /** Run a change; its result becomes the data, and errors show on the screen. */
  const change = useCallback(async (fn: () => Promise<T | void>) => {
    try {
      const next = await fn()
      if (next !== undefined) setData(next)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])
  return { data, error, reload, change }
}
