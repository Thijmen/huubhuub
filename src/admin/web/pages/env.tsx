import { useEffect, useState } from "react"
import { api, enc, type EnvPlan } from "../api"
import { Badge, Button, Confirm, Empty, ErrorBanner, PageHeader, relTime, useAction, useApi } from "../ui"

interface EnvList {
  vars: { name: string; masked: string; updatedAt: number }[]
  protected: string[]
}

const PLACEHOLDER = `# Paste a .env file, a JSON object or bare keys
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...
sk-proj-...        # bare keys are recognised by prefix
GITHUB_TOKEN=ghp_...`

export function EnvPage() {
  const list = useApi<EnvList>("/api/env")
  const [text, setText] = useState("")
  const [preview, setPreview] = useState<{ plan: EnvPlan[]; errors: string[] }>()
  const [result, setResult] = useState<{ results: { name: string; ok: boolean; action: string; message?: string }[]; models: number }>()
  const { busy, run } = useAction()

  useEffect(() => {
    setResult(undefined)
    if (!text.trim()) return setPreview(undefined)
    const t = setTimeout(() => {
      api<{ plan: EnvPlan[]; errors: string[] }>("POST", "/api/env/preview", { text })
        .then(setPreview)
        .catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [text])

  const importable = preview?.plan.filter((p) => !p.protected) ?? []

  const doImport = async () => {
    const res = await run("import", () => api<NonNullable<typeof result>>("POST", "/api/env/import", { text }))
    if (!res) return
    setResult(res)
    setText("")
    setPreview(undefined)
    await list.reload()
  }

  return (
    <>
      <PageHeader title="Paste env" subtitle="Drop in API keys and tokens. Keys that belong to a provider go to OpenCode's credential store; everything else becomes a managed environment variable." />
      <div className="grid-env">
        <section className="card paste">
          <textarea
            className="paste-area mono"
            spellCheck={false}
            placeholder={PLACEHOLDER}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && importable.length) void doImport()
            }}
          />
          <div className="paste-foot">
            <span className="muted small">Values never leave this server. ⌘↵ to import.</span>
            <Button variant="primary" busy={busy === "import"} disabled={!importable.length} onClick={doImport}>
              Import {importable.length || ""}
            </Button>
          </div>
        </section>

        <section className="card plan">
          <h3>What will happen</h3>
          {result ? (
            <>
              <ul className="plan-list">
                {result.results.map((r) => (
                  <li key={r.name} className={r.ok ? "" : "failed"}>
                    <span className={`plan-icon ${r.ok ? "ok" : "err"}`}>{r.ok ? "✓" : "!"}</span>
                    <code>{r.name}</code>
                    <span className="muted small">{r.ok ? (r.action === "credential" ? "stored as credential" : "set in environment") : r.message}</span>
                  </li>
                ))}
              </ul>
              <div className="callout callout-ok">
                <p>
                  <strong>{result.models}</strong> models are available now.
                </p>
              </div>
            </>
          ) : !preview ? (
            <Empty icon="⌘" title="Waiting for a paste">
              The plan shows up here as you type.
            </Empty>
          ) : (
            <>
              <ul className="plan-list">
                {preview.plan.map((p) => (
                  <li key={p.name} className={p.protected ? "failed" : ""}>
                    <span className={`plan-icon ${p.protected ? "err" : p.action === "credential" ? "cred" : "env"}`}>
                      {p.protected ? "✕" : p.action === "credential" ? "⚿" : "$"}
                    </span>
                    <div className="plan-text">
                      <div>
                        <code>{p.name}</code>
                        {p.guessed && <Badge tone="accent">guessed</Badge>}
                        {p.exists && !p.protected && <Badge tone="warn">replaces</Badge>}
                      </div>
                      <div className="muted small">
                        {p.protected
                          ? "Protected. Set it in the container environment."
                          : p.action === "credential"
                            ? `Connects ${p.integration?.name}`
                            : p.integration
                              ? `Environment variable used by ${p.integration.name}`
                              : "Environment variable"}
                      </div>
                    </div>
                    <span className="mono muted small">{p.masked}</span>
                  </li>
                ))}
              </ul>
              {preview.errors.map((e) => (
                <div key={e} className="form-error">
                  {e}
                </div>
              ))}
            </>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Managed variables</h3>
          <span className="muted small">Stored in the bot's database and exported at startup.</span>
        </div>
        <ErrorBanner error={list.error} onRetry={list.reload} />
        {!list.data?.vars.length ? (
          <p className="muted">Nothing here yet.</p>
        ) : (
          <table className="table">
            <tbody>
              {list.data.vars.map((v) => (
                <tr key={v.name}>
                  <td>
                    <code>{v.name}</code>
                  </td>
                  <td className="mono muted">{v.masked}</td>
                  <td className="muted small">{relTime(v.updatedAt)}</td>
                  <td className="cell-actions">
                    <Confirm text="Delete?" onConfirm={() => run(`rm-${v.name}`, () => api("DELETE", `/api/env/${enc(v.name)}`).then(list.reload), `${v.name} removed`)}>
                      {(ask) => (
                        <Button size="sm" variant="ghost" busy={busy === `rm-${v.name}`} onClick={ask}>
                          Delete
                        </Button>
                      )}
                    </Confirm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}
