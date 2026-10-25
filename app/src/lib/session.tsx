import * as Device from "expo-device"
import * as SecureStore from "expo-secure-store"
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import type { Me } from "@server/protocol"
import { Api } from "./api"

const KEY = "huubhuub.session"

interface Stored {
  server: string
  token: string
  me: Me
}

interface SessionValue {
  /** undefined while loading from secure storage, null when signed out. */
  session: Stored | null | undefined
  api: Api | null
  signIn: (server: string, code: string) => Promise<void>
  signOut: () => Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Stored | null | undefined>(undefined)

  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then((raw) => setSession(raw ? (JSON.parse(raw) as Stored) : null))
      .catch(() => setSession(null))
  }, [])

  const forget = useCallback(async () => {
    setSession(null)
    await SecureStore.deleteItemAsync(KEY).catch(() => {})
  }, [])

  const api = useMemo(() => (session ? new Api(session.server, session.token, () => void forget()) : null), [session?.server, session?.token, forget])

  // Keep the name and features current; a 401 here signs the phone out.
  useEffect(() => {
    if (!api || !session) return
    api
      .me()
      .then((me) => {
        const next = { ...session, me }
        setSession(next)
        return SecureStore.setItemAsync(KEY, JSON.stringify(next))
      })
      .catch(() => {})
    // Only when the sign-in changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  const signIn = useCallback(async (server: string, code: string) => {
    const platform = process.env.EXPO_OS === "ios" ? "ios" : "android"
    const deviceName = Device.deviceName ?? Device.modelName ?? null
    const { token, me } = await Api.pair(server, code, deviceName, platform)
    const next = { server, token, me }
    await SecureStore.setItemAsync(KEY, JSON.stringify(next))
    setSession(next)
  }, [])

  const signOut = useCallback(async () => {
    await api?.signOut().catch(() => {})
    await forget()
  }, [api, forget])

  const value = useMemo(() => ({ session, api, signIn, signOut }), [session, api, signIn, signOut])
  return <SessionContext value={value}>{children}</SessionContext>
}

export function useSession(): SessionValue {
  const value = use(SessionContext)
  if (!value) throw new Error("useSession outside SessionProvider")
  return value
}

/** The API for screens that only render when signed in. */
export function useApi(): Api {
  const { api } = useSession()
  if (!api) throw new Error("Not signed in")
  return api
}
