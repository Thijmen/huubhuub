import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { api } from "./api"

type Toast = { id: number; kind: "ok" | "error" | "info"; text: string }
const ToastContext = createContext<(kind: Toast["kind"], text: string) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-3), { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
            <span className="toast-dot" />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

/** Fetch a GET endpoint, with a manual `reload` and optional polling. */
export function useApi<T>(path: string, poll?: number) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    try {
      setData(await api<T>("GET", path))
      setError(undefined)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [path])
  useEffect(() => {
    void reload()
    if (!poll) return
    const t = setInterval(() => void reload(), poll)
    return () => clearInterval(t)
  }, [reload, poll])
  return { data, error, loading, reload, setData }
}

/** Wrap an async action with a busy flag and toast on failure. */
export function useAction() {
  const toast = useToast()
  const [busy, setBusy] = useState<string>()
  const run = useCallback(
    async <T,>(id: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(id)
      try {
        const out = await fn()
        if (success) toast("ok", success)
        return out
      } catch (err) {
        toast("error", (err as Error).message)
        return undefined
      } finally {
        setBusy(undefined)
      }
    },
    [toast],
  )
  return { busy, run }
}

export function Button({
  children,
  variant = "default",
  size,
  busy,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger"
  size?: "sm"
  busy?: boolean
}) {
  return (
    <button {...props} disabled={props.disabled || busy} className={`btn btn-${variant} ${size ? `btn-${size}` : ""} ${props.className ?? ""}`}>
      {busy && <span className="spinner" />}
      {children}
    </button>
  )
}

export function Badge({ tone = "neutral", children, pulse }: { tone?: "ok" | "warn" | "error" | "neutral" | "accent"; children: ReactNode; pulse?: boolean }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span className={`badge-dot ${pulse ? "pulse" : ""}`} />
      {children}
    </span>
  )
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="toggle-knob" />
    </button>
  )
}

export function Modal({ title, subtitle, onClose, children, wide }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? "active" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h4>{title}</h4>
      {children && <p className="muted">{children}</p>}
    </div>
  )
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeletons">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ animationDelay: `${i * 80}ms` }} />
      ))}
    </div>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

export function ErrorBanner({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  if (!error) return null
  return (
    <div className="banner banner-error">
      <span>{error}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}

export function Confirm({ text, onConfirm, children }: { text: string; onConfirm: () => void; children: (ask: () => void) => ReactNode }) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (armed)
    return (
      <Button
        size="sm"
        variant="danger"
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
      >
        {text}
      </Button>
    )
  return children(() => {
    setArmed(true)
    timer.current = setTimeout(() => setArmed(false), 3000)
  })
}

export function Initials({ name, seed }: { name: string; seed?: string }) {
  const letters = name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("")
  return (
    <span className="avatar" style={{ "--hue": hue(seed ?? name) } as React.CSSProperties}>
      {letters || "?"}
    </span>
  )
}

function hue(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export function relTime(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.round(diff / 1000)
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ms).toLocaleDateString()
}

export function duration(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export async function copy(text: string, toast: (k: "ok", t: string) => void) {
  await navigator.clipboard.writeText(text)
  toast("ok", "Copied")
}
