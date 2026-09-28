import { useState } from "react"
import { api, enc, type McpConfig, type McpServer } from "../api"
import { Badge, Button, Confirm, Empty, ErrorBanner, Field, Modal, PageHeader, Segmented, Skeleton, Toggle, useAction, useApi, useToast } from "../ui"
import { McpBadge } from "./overview"

export function McpPage() {
  const { data, error, reload } = useApi<McpServer[]>("/api/mcp", 5000)
  const [dialog, setDialog] = useState<"add" | "import" | { edit: McpServer }>()
  const { busy, run } = useAction()

  return (
    <>
      <PageHeader
        title="MCP servers"
        subtitle="Tools the agent can call. Changes apply live and survive restarts."
        actions={
          <>
            <Button onClick={() => setDialog("import")}>Import JSON</Button>
            <Button variant="primary" onClick={() => setDialog("add")}>
              + Add server
            </Button>
          </>
        }
      />
      <ErrorBanner error={error} onRetry={reload} />
      {!data ? (
        <Skeleton rows={3} />
      ) : data.length === 0 ? (
        <Empty icon="⬡" title="No MCP servers yet">
          Add a local command or a remote URL, or paste a config from a README.
        </Empty>
      ) : (
        <div className="mcp-list">
          {data.map((s) => {
            const enabled = s.status !== "disabled"
            return (
              <article key={s.name} className={`mcp card status-${s.status}`}>
                <div className="mcp-head">
                  <div className="mcp-title">
                    <span className="mcp-kind">{s.config?.type === "remote" ? "◍" : "▣"}</span>
                    <div>
                      <div className="mcp-name">{s.name}</div>
                      <div className="mcp-target mono">{describe(s.config)}</div>
                    </div>
                  </div>
                  <div className="mcp-actions">
                    <McpBadge status={s.status} />
                    {s.source === "config" && <Badge>bot.opencode.jsonc</Badge>}
                    <Toggle
                      checked={enabled}
                      disabled={!s.config || busy === `t-${s.name}`}
                      onChange={(v) =>
                        run(`t-${s.name}`, () => api("PUT", `/api/mcp/${enc(s.name)}/enabled`, { enabled: v }).then(reload), `${s.name} ${v ? "enabled" : "disabled"}`)
                      }
                    />
                  </div>
                </div>
                {s.error && <pre className="mcp-error">{s.error}</pre>}
                <div className="mcp-foot">
                  {enabled && (
                    <Button size="sm" variant="ghost" busy={busy === `r-${s.name}`} onClick={() => run(`r-${s.name}`, () => api("POST", `/api/mcp/${enc(s.name)}/reconnect`).then(reload), "Reconnecting")}>
                      ↻ Reconnect
                    </Button>
                  )}
                  {s.config && (
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ edit: s })}>
                      Edit
                    </Button>
                  )}
                  <Confirm text="Remove server?" onConfirm={() => run(`d-${s.name}`, () => api("DELETE", `/api/mcp/${enc(s.name)}`).then(reload), `${s.name} removed`)}>
                    {(ask) => (
                      <Button size="sm" variant="ghost" busy={busy === `d-${s.name}`} onClick={ask}>
                        Remove
                      </Button>
                    )}
                  </Confirm>
                </div>
              </article>
            )
          })}
        </div>
      )}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(undefined)} onDone={reload} />}
      {(dialog === "add" || (typeof dialog === "object" && dialog)) && (
        <ServerDialog server={typeof dialog === "object" ? dialog.edit : undefined} onClose={() => setDialog(undefined)} onDone={reload} />
      )}
    </>
  )
}

function describe(c: McpConfig | null) {
  if (!c) return "—"
  return c.type === "remote" ? c.url : c.command.join(" ")
}

const toLines = (m?: Record<string, string>, sep = "=") =>
  Object.entries(m ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n")

function ServerDialog({ server, onClose, onDone }: { server?: McpServer; onClose: () => void; onDone: () => Promise<void> }) {
  const c = server?.config
  const [type, setType] = useState<"local" | "remote">(c?.type ?? "local")
  const [name, setName] = useState(server?.name ?? "")
  const [command, setCommand] = useState(c?.type === "local" ? c.command.map(quote).join(" ") : "")
  const [cwd, setCwd] = useState(c?.type === "local" ? (c.cwd ?? "") : "")
  const [env, setEnv] = useState(c?.type === "local" ? toLines(c.environment) : "")
  const [url, setUrl] = useState(c?.type === "remote" ? c.url : "")
  const [headers, setHeaders] = useState(c?.type === "remote" ? toLines(c.headers, ": ") : "")
  const [oauth, setOauth] = useState(c?.type === "remote" ? c.oauth !== false : true)
  const [timeout, setTimeout_] = useState(c?.timeout?.startup ? String(c.timeout.startup) : "")
  const { busy, run } = useAction()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const timeoutMs = Number(timeout) > 0 ? { timeout: { startup: Number(timeout) } } : {}
    const config =
      type === "local"
        ? { type, command, ...(cwd ? { cwd } : {}), environment: pairs(env, "="), ...timeoutMs, ...(c?.disabled ? { disabled: true } : {}) }
        : { type, url, headers: pairs(headers, ":"), ...(oauth ? {} : { oauth: false }), ...timeoutMs, ...(c?.disabled ? { disabled: true } : {}) }
    const ok = await run("save", () => api("POST", "/api/mcp", { name, config }), server ? `${name} updated` : `${name} added`)
    if (ok !== undefined) {
      await onDone()
      onClose()
    }
  }

  return (
    <Modal title={server ? `Edit ${server.name}` : "Add MCP server"} subtitle="Local servers run as a process in the container; remote ones connect over HTTP." onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { value: "local", label: "Local command" },
            { value: "remote", label: "Remote URL" },
          ]}
        />
        <Field label="Name">
          <input className="input mono" autoFocus={!server} disabled={Boolean(server)} placeholder="github" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {type === "local" ? (
          <>
            <Field label="Command" hint="Quoted arguments are kept together.">
              <input className="input mono" placeholder="npx -y @modelcontextprotocol/server-github" value={command} onChange={(e) => setCommand(e.target.value)} />
            </Field>
            <Field label="Environment" hint="One KEY=value per line.">
              <textarea className="input mono" rows={3} placeholder="GITHUB_TOKEN=ghp_..." value={env} onChange={(e) => setEnv(e.target.value)} />
            </Field>
            <Field label="Working directory" hint="Optional.">
              <input className="input mono" placeholder="/workspace" value={cwd} onChange={(e) => setCwd(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <input className="input mono" placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field label="Headers" hint="One Header: value per line.">
              <textarea className="input mono" rows={3} placeholder="Authorization: Bearer ..." value={headers} onChange={(e) => setHeaders(e.target.value)} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={oauth} onChange={(e) => setOauth(e.target.checked)} />
              <span>Allow OAuth if the server asks for it</span>
            </label>
          </>
        )}
        <Field label="Startup timeout (ms)" hint="Optional.">
          <input className="input mono" type="number" min={0} placeholder="30000" value={timeout} onChange={(e) => setTimeout_(e.target.value)} />
        </Field>
        <div className="row-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" busy={busy === "save"} disabled={!name.trim() || (type === "local" ? !command.trim() : !url.trim())}>
            {server ? "Save" : "Add server"}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

const IMPORT_PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    },
    "linear": { "url": "https://mcp.linear.app/mcp" }
  }
}`

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast()
  const [text, setText] = useState("")
  const [name, setName] = useState("")
  const [errors, setErrors] = useState<string[]>([])
  const { busy, run } = useAction()

  const submit = async () => {
    const res = await run("import", () => api<{ added: string[]; errors: string[] }>("POST", "/api/mcp/import", { text, name }))
    if (!res) return
    setErrors(res.errors)
    if (res.added.length) {
      toast("ok", `Added ${res.added.join(", ")}`)
      await onDone()
      if (!res.errors.length) onClose()
    }
  }

  return (
    <Modal wide title="Import MCP config" subtitle="Paste a Claude Desktop, Cursor or OpenCode snippet, or a single server object." onClose={onClose}>
      <div className="stack">
        <textarea className="paste-area mono" rows={12} spellCheck={false} placeholder={IMPORT_PLACEHOLDER} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <Field label="Name" hint="Only needed when pasting a single server without a name.">
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
        </Field>
        {errors.map((e) => (
          <div key={e} className="form-error">
            {e}
          </div>
        ))}
        <div className="row-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy === "import"} disabled={!text.trim()} onClick={submit}>
            Import
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function pairs(text: string, sep: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const i = line.indexOf(sep)
    if (!line || line.startsWith("#") || i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

function quote(arg: string) {
  if (!/[\s"']/.test(arg)) return arg
  return arg.includes('"') ? `'${arg}'` : `"${arg}"`
}
