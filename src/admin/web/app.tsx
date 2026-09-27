import { useCallback, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { api, auth, setUnauthorisedHandler } from "./api"
import { McpPage } from "./pages/mcp"
import { EnvPage } from "./pages/env"
import { OverviewPage } from "./pages/overview"
import { ProvidersPage } from "./pages/providers"
import { SettingsPage } from "./pages/settings"
import { ThreadsPage } from "./pages/threads"
import { Button, ToastProvider } from "./ui"

const TABS = [
  { id: "overview", label: "Overview", icon: "◎" },
  { id: "providers", label: "Providers", icon: "⚡" },
  { id: "env", label: "Paste env", icon: "⌘" },
  { id: "mcp", label: "MCP servers", icon: "⬡" },
  { id: "threads", label: "Conversations", icon: "✦" },
  { id: "settings", label: "Settings", icon: "⚙" },
] as const

type Tab = (typeof TABS)[number]["id"]

function currentTab(): Tab {
  const id = location.hash.slice(1).split("/")[0]
  return (TABS.find((t) => t.id === id)?.id ?? "overview") as Tab
}

function currentThread(): string | undefined {
  const [tab, id] = location.hash.slice(1).split("/")
  return tab === "threads" && id ? decodeURIComponent(id) : undefined
}

function App() {
  const [authed, setAuthed] = useState<boolean | undefined>(undefined)
  const [tab, setTab] = useState<Tab>(currentTab)
  const [thread, setThread] = useState(currentThread)
  const openThread = useCallback((id?: string) => {
    const hash = id ? `threads/${encodeURIComponent(id)}` : "threads"
    if (id && location.hash.slice(1).split("/").length === 1) history.replaceState(null, "", `#${hash}`)
    else location.hash = hash
    setThread(id)
  }, [])

  useEffect(() => {
    setUnauthorisedHandler(() => {
      auth.clear()
      setAuthed(false)
    })
    const token = auth.get()
    if (!token) return setAuthed(false)
    api("GET", "/api/overview")
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false))
  }, [])

  useEffect(() => {
    const onHash = () => {
      setTab(currentTab())
      setThread(currentThread())
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  if (authed === undefined) return <div className="boot"><span className="spinner lg" /></div>
  if (!authed) return <Login onDone={() => setAuthed(true)} />

  const go = (id: Tab) => (location.hash = id)

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span />
          </div>
          <div>
            <div className="brand-name">opencode</div>
            <div className="brand-sub">telegram control room</div>
          </div>
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={`nav-item ${tab === t.id ? "active" : ""}`} onClick={() => go(t.id)}>
              <span className="nav-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              auth.clear()
              setAuthed(false)
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>
      <main className={`main ${tab === "threads" ? "main-full" : ""}`}>
        <div className={`page ${tab === "threads" ? "page-full" : ""}`} key={tab}>
          {tab === "overview" && <OverviewPage go={go} />}
          {tab === "providers" && <ProvidersPage />}
          {tab === "env" && <EnvPage />}
          {tab === "mcp" && <McpPage />}
          {tab === "threads" && <ThreadsPage selected={thread} open={openThread} />}
          {tab === "settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  )
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await api("GET", "/api/overview", undefined, token.trim())
      auth.set(token.trim())
      onDone()
    } catch (err) {
      setError((err as Error).message === "Unauthorised" ? "That token doesn't match ADMIN_TOKEN." : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login-glow" />
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark lg">
          <span />
        </div>
        <h1>Control room</h1>
        <p className="muted">Enter the admin token. It's the ADMIN_TOKEN env var, or the one printed in the bot's startup log.</p>
        <input
          autoFocus
          type="password"
          className="input mono"
          placeholder="admin token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        {error && <div className="form-error">{error}</div>}
        <Button variant="primary" busy={busy} disabled={!token.trim()} type="submit">
          Unlock
        </Button>
      </form>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
)
