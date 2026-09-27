import { useEffect, useMemo, useRef, useState } from "react"
import { api, enc, type FormField, type Method, type OAuthAttempt, type OAuthStatus, type Provider } from "../api"
import { Badge, Button, Confirm, copy, Empty, ErrorBanner, Field, Initials, Modal, PageHeader, Segmented, Skeleton, useAction, useApi, useToast } from "../ui"

type Filter = "all" | "connected" | "available"

export function ProvidersPage() {
  const { data, error, reload } = useApi<Provider[]>("/api/providers")
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [openId, setOpenId] = useState<string>()
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data ?? [])
      .filter((p) => (filter === "connected" ? isConnected(p) : filter === "available" ? !isConnected(p) : true))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .sort((a, b) => Number(isConnected(b)) - Number(isConnected(a)) || a.name.localeCompare(b.name))
  }, [data, query, filter])

  const connected = data?.filter(isConnected).length ?? 0
  const open = data?.find((p) => p.id === openId)

  return (
    <>
      <PageHeader
        title="Providers"
        subtitle={data ? `${connected} connected · ${data.length} available` : "Connect model providers with an API key or OAuth."}
      />
      <ErrorBanner error={error} onRetry={reload} />
      <div className="toolbar">
        <div className="search">
          <span className="search-icon">⌕</span>
          <input ref={search} className="input" placeholder="Search providers…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <kbd>/</kbd>
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "connected", label: "Connected" },
            { value: "available", label: "Available" },
          ]}
        />
      </div>
      {!data ? (
        <Skeleton rows={6} />
      ) : list.length === 0 ? (
        <Empty icon="⌕" title="No providers match">
          Try a different search.
        </Empty>
      ) : (
        <div className="provider-grid">
          {list.map((p) => (
            <button key={p.id} className={`provider card ${isConnected(p) ? "connected" : ""}`} onClick={() => setOpenId(p.id)}>
              <Initials name={p.name} seed={p.id} />
              <div className="provider-text">
                <div className="provider-name">{p.name}</div>
                <div className="provider-sub mono">{p.id}</div>
              </div>
              <div className="provider-state">
                {isConnected(p) ? <Badge tone="ok">{p.models} models</Badge> : p.custom ? <Badge>config</Badge> : <span className="chev">›</span>}
              </div>
            </button>
          ))}
        </div>
      )}
      {open && <ProviderModal provider={open} onClose={() => setOpenId(undefined)} onChange={reload} />}
    </>
  )
}

function isConnected(p: Provider) {
  return p.connections.length > 0 || p.models > 0
}

function ProviderModal({ provider, onClose, onChange }: { provider: Provider; onClose: () => void; onChange: () => Promise<void> }) {
  const { busy, run } = useAction()
  const methods = provider.methods.filter((m) => m.type !== "env")
  const envMethod = provider.methods.find((m): m is Extract<Method, { type: "env" }> => m.type === "env")
  const [tab, setTab] = useState(methodKey(methods[0]))
  const credentials = provider.connections.filter((c) => c.type === "credential")
  const envs = provider.connections.filter((c) => c.type === "env")

  return (
    <Modal
      title={
        <span className="modal-title-row">
          <Initials name={provider.name} seed={provider.id} />
          {provider.name}
        </span>
      }
      subtitle={
        <>
          <span className="mono">{provider.id}</span> · {provider.models} models available
        </>
      }
      onClose={onClose}
    >
      {(credentials.length > 0 || envs.length > 0) && (
        <section className="section">
          <h4 className="section-title">Connections</h4>
          <ul className="conn-list">
            {credentials.map((c) => (
              <li key={c.id}>
                <span className="conn-icon">{c.method === "oauth" ? "⇄" : "⚿"}</span>
                <div className="conn-text">
                  <div>{c.label}</div>
                  <div className="muted small">{c.method === "oauth" ? "OAuth" : "API key"} · stored by OpenCode</div>
                </div>
                {credentials.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={busy === `act-${c.id}`}
                    onClick={() => run(`act-${c.id}`, () => api("POST", `/api/credentials/${enc(c.id)}/activate`).then(onChange), "Switched credential")}
                  >
                    Use this
                  </Button>
                )}
                <Confirm text="Remove?" onConfirm={() => run(`rm-${c.id}`, () => api("DELETE", `/api/credentials/${enc(c.id)}`).then(onChange), "Credential removed")}>
                  {(ask) => (
                    <Button size="sm" variant="ghost" busy={busy === `rm-${c.id}`} onClick={ask}>
                      Remove
                    </Button>
                  )}
                </Confirm>
              </li>
            ))}
            {envs.map((c) => (
              <li key={c.name}>
                <span className="conn-icon">$</span>
                <div className="conn-text">
                  <div className="mono">{c.name}</div>
                  <div className="muted small mono">{c.masked || "set"} · environment</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {methods.length > 0 && (
        <section className="section">
          <h4 className="section-title">{credentials.length ? "Add another" : "Connect"}</h4>
          {methods.length > 1 && (
            <div className="tabs-inline">
              {methods.map((m) => (
                <button key={methodKey(m)} className={tab === methodKey(m) ? "active" : ""} onClick={() => setTab(methodKey(m))}>
                  {methodLabel(m)}
                </button>
              ))}
            </div>
          )}
          {methods.map((m) =>
            methodKey(m) !== tab ? null : m.type === "key" ? (
              <KeyForm key="key" provider={provider} onDone={onChange} />
            ) : m.type === "oauth" ? (
              <OAuthFlow key={m.id} provider={provider} method={m} onDone={onChange} />
            ) : m.type === "command" ? (
              <div key={m.id} className="callout">
                <p>This provider connects by running a command inside the container:</p>
                <pre className="code">{m.command.join(" ")}</pre>
              </div>
            ) : null,
          )}
        </section>
      )}

      {envMethod && (
        <section className="section">
          <h4 className="section-title">Or via environment</h4>
          <EnvForm names={envMethod.names} onDone={onChange} />
        </section>
      )}

      {methods.length === 0 && !envMethod && (
        <div className="callout">
          <p>This provider is defined in <code>opencode.jsonc</code> and is configured there.</p>
        </div>
      )}
    </Modal>
  )
}

function methodKey(m?: Method) {
  if (!m) return ""
  return m.type === "oauth" || m.type === "command" ? `${m.type}:${m.id}` : m.type
}

function methodLabel(m: Method) {
  if (m.type === "key") return m.label ?? "API key"
  if (m.type === "oauth" || m.type === "command") return m.label
  return "Environment"
}

function KeyForm({ provider, onDone }: { provider: Provider; onDone: () => Promise<void> }) {
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  const { busy, run } = useAction()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const ok = await run("key", () => api("POST", `/api/providers/${enc(provider.id)}/key`, { key, label }), `${provider.name} connected`)
    if (ok !== undefined) {
      setKey("")
      setLabel("")
      await onDone()
    }
  }
  return (
    <form className="stack" onSubmit={submit}>
      <Field label="API key">
        <input autoFocus type="password" className="input mono" placeholder="paste your key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Label" hint="Optional. Helps tell keys apart.">
        <input className="input" placeholder="e.g. personal" value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className="row-end">
        <Button variant="primary" busy={busy === "key"} disabled={!key.trim()} type="submit">
          Connect
        </Button>
      </div>
    </form>
  )
}

function EnvForm({ names, onDone }: { names: string[]; onDone: () => Promise<void> }) {
  const [name, setName] = useState(names[0] ?? "")
  const [value, setValue] = useState("")
  const { busy, run } = useAction()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const ok = await run("env", () => api("PUT", `/api/env/${enc(name)}`, { value }), `${name} saved`)
    if (ok !== undefined) {
      setValue("")
      await onDone()
    }
  }
  return (
    <form className="env-inline" onSubmit={submit}>
      {names.length > 1 ? (
        <select className="input mono" value={name} onChange={(e) => setName(e.target.value)}>
          {names.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      ) : (
        <code className="env-name">{name}</code>
      )}
      <input type="password" className="input mono" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
      <Button busy={busy === "env"} disabled={!value} type="submit">
        Save
      </Button>
    </form>
  )
}

function OAuthFlow({ provider, method, onDone }: { provider: Provider; method: Extract<Method, { type: "oauth" }>; onDone: () => Promise<void> }) {
  const toast = useToast()
  const fields = (method.form ?? []).filter((f) => !f.hidden && f.type !== "external")
  const [answer, setAnswer] = useState<Record<string, string | boolean | number>>(() => defaults(fields))
  const [attempt, setAttempt] = useState<OAuthAttempt>()
  const [status, setStatus] = useState<OAuthStatus>()
  const [code, setCode] = useState("")
  const { busy, run } = useAction()
  const base = `/api/providers/${enc(provider.id)}/oauth`

  useEffect(() => {
    if (!attempt || status?.status !== "pending") return
    const t = setInterval(async () => {
      const s = await api<OAuthStatus>("GET", `${base}/${enc(attempt.attemptID)}`).catch(() => undefined)
      if (!s) return
      setStatus(s)
      if (s.status === "complete") {
        toast("ok", `${provider.name} connected`)
        void onDone()
      }
    }, 2000)
    return () => clearInterval(t)
  }, [attempt, status?.status])

  const pending = useRef<string>(undefined)
  pending.current = attempt && status?.status === "pending" ? attempt.attemptID : undefined
  useEffect(
    () => () => {
      if (pending.current) void api("DELETE", `${base}/${enc(pending.current)}`).catch(() => {})
    },
    [],
  )

  const start = () =>
    run("start", async () => {
      const a = await api<OAuthAttempt>("POST", base, { methodID: method.id, ...(fields.length ? { answer } : {}) })
      setAttempt(a)
      setStatus({ status: "pending" })
      setCode("")
      if (a.mode === "auto" && a.url) window.open(a.url, "_blank", "noopener")
    })

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault()
    if (!attempt) return
    void run(
      "code",
      async () => {
        await api("POST", `${base}/${enc(attempt.attemptID)}`, { code })
        setStatus({ status: "complete" })
        await onDone()
      },
      `${provider.name} connected`,
    )
  }

  if (attempt && status) {
    if (status.status === "complete")
      return (
        <div className="callout callout-ok">
          <p>
            <strong>Connected.</strong> {provider.name} models are now available to the bot.
          </p>
        </div>
      )
    if (status.status === "failed" || status.status === "expired")
      return (
        <div className="callout callout-error">
          <p>{status.status === "failed" ? status.message : "The sign-in link expired."}</p>
          <Button onClick={start} busy={busy === "start"}>
            Try again
          </Button>
        </div>
      )
    const deviceCode = attempt.instructions.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0]
    return (
      <div className="oauth">
        <ol className="steps">
          <li>
            <span>Open the sign-in page</span>
            <div className="row">
              <a className="btn btn-primary" href={attempt.url} target="_blank" rel="noopener">
                Open {provider.name} ↗
              </a>
              <Button variant="ghost" size="sm" onClick={() => copy(attempt.url, toast)}>
                Copy link
              </Button>
            </div>
          </li>
          {attempt.instructions && (
            <li>
              <span>{attempt.instructions}</span>
              {deviceCode && (
                <button className="device-code" onClick={() => copy(deviceCode, toast)} title="Copy">
                  {deviceCode}
                </button>
              )}
            </li>
          )}
          {attempt.mode === "code" ? (
            <li>
              <span>Paste the code you get back</span>
              <form className="env-inline" onSubmit={submitCode}>
                <input autoFocus className="input mono" placeholder="authorisation code" value={code} onChange={(e) => setCode(e.target.value)} />
                <Button variant="primary" busy={busy === "code"} disabled={!code.trim()} type="submit">
                  Finish
                </Button>
              </form>
            </li>
          ) : (
            <li>
              <span className="waiting">
                <span className="spinner" /> Waiting for you to approve…
              </span>
            </li>
          )}
        </ol>
      </div>
    )
  }

  return (
    <div className="stack">
      {fields.map((f) => (
        <FormInput key={f.key} field={f} value={answer[f.key]} onChange={(v) => setAnswer((a) => ({ ...a, [f.key]: v }))} />
      ))}
      <div className="row-end">
        <Button variant="primary" busy={busy === "start"} onClick={start}>
          {method.label}
        </Button>
      </div>
    </div>
  )
}

function defaults(fields: FormField[]) {
  const out: Record<string, string | boolean | number> = {}
  for (const f of fields) {
    if (f.default !== undefined && (typeof f.default === "string" || typeof f.default === "boolean" || typeof f.default === "number")) out[f.key] = f.default
    else if (f.type === "boolean") out[f.key] = false
    else if (f.options?.[0]) out[f.key] = f.options[0].value
  }
  return out
}

function FormInput({ field, value, onChange }: { field: FormField; value: unknown; onChange: (v: string | boolean | number) => void }) {
  const label = field.title ?? field.key
  if (field.type === "boolean")
    return (
      <label className="check">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
    )
  if (field.options?.length)
    return (
      <Field label={label} hint={field.description}>
        <select className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    )
  return (
    <Field label={label} hint={field.description}>
      <input
        className="input"
        type={field.type === "number" || field.type === "integer" ? "number" : "text"}
        placeholder={field.placeholder}
        value={String(value ?? "")}
        onChange={(e) => onChange(field.type === "number" || field.type === "integer" ? Number(e.target.value) : e.target.value)}
      />
    </Field>
  )
}
