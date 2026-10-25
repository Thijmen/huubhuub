import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { AppState } from "react-native"
import type { QuestionAction } from "@server/protocol"
import { ApiError } from "./api"
import { chatReducer, initialChat } from "./chat-state"
import { t } from "./i18n"
import type { Photo } from "./media"
import { useApi } from "./session"

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000]

/**
 * One conversation: its messages, live updates while the app is in the foreground, and what you can do in it.
 * Events are streamed; anything structural (a message from Telegram, a finished run) reloads the latest page.
 */
export function useConversation(id: string) {
  const api = useApi()
  const [state, dispatch] = useReducer(chatReducer, initialChat)
  const [error, setError] = useState<string | null>(null)
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const reload = useCallback(async () => {
    try {
      dispatch({ type: "page", page: await api.conversation(id) })
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [api, id])

  const reloadSoon = useCallback(() => {
    clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => void reload(), 300)
  }, [reload])

  useEffect(() => {
    void reload()
    return () => clearTimeout(reloadTimer.current)
  }, [reload])

  // Live events while the app is open. Android drops background connections, so reconnect on return.
  useEffect(() => {
    let controller: AbortController | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let stopped = false

    const connect = () => {
      if (stopped || controller) return
      const current = new AbortController()
      controller = current
      api
        .events(
          id,
          (event) => {
            attempt = 0
            if (event.type === "ready") return void reload()
            dispatch({ type: "event", event })
            if (event.type === "refresh" || event.type === "run.ended") reloadSoon()
          },
          current.signal,
        )
        .catch(() => {})
        .finally(() => {
          if (controller === current) controller = undefined
          if (stopped || current.signal.aborted) return
          retryTimer = setTimeout(connect, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)])
        })
    }
    const disconnect = () => {
      clearTimeout(retryTimer)
      controller?.abort()
      controller = undefined
    }

    connect()
    const sub = AppState.addEventListener("change", (s) => (s === "active" ? connect() : disconnect()))
    return () => {
      stopped = true
      sub.remove()
      disconnect()
    }
  }, [api, id, reload, reloadSoon])

  const send = useCallback(
    async (text: string, photos: Photo[] = []) => {
      const pending = { id: `local-${Date.now()}`, text, images: photos.map((p) => p.uri), createdAt: Date.now() }
      // An answer to an open question doesn't become a message of its own.
      if (!state.question || photos.length) dispatch({ type: "pending", pending })
      try {
        await api.send(id, text, photos.map(({ data, name }) => ({ data, name })))
        setError(null)
      } catch (err) {
        dispatch({ type: "unsent", id: pending.id })
        setError(t("sendFailed", { error: (err as Error).message }))
        throw err
      }
    },
    [api, id, state.question],
  )

  const stop = useCallback(() => api.stop(id).catch((err: Error) => setError(err.message)), [api, id])

  const answer = useCallback(
    async (action: QuestionAction) => {
      if (!state.question) return
      try {
        dispatch({ type: "question", question: await api.answer(id, state.question.formID, action) })
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) return void reload()
        setError((err as Error).message)
      }
    },
    [api, id, state.question, reload],
  )

  const loadOlder = useCallback(async () => {
    if (!state.older) return
    try {
      dispatch({ type: "page", page: await api.conversation(id, state.older), older: true })
    } catch (err) {
      setError((err as Error).message)
    }
  }, [api, id, state.older])

  const transcribe = useCallback(async (audio: string, mime: string) => (await api.transcribe(audio, mime)).text, [api])

  const organised = useCallback((c: { pinned: boolean; archived: boolean }) => dispatch({ type: "organised", pinned: c.pinned, archived: c.archived }), [])

  return { state, error, send, stop, answer, loadOlder, reload, transcribe, organised }
}
