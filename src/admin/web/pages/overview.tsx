import { openOpenCode, type OpenCodeStatus, type Overview } from "../api"
import { Badge, Button, duration, ErrorBanner, PageHeader, Skeleton, useAction, useApi } from "../ui"

type Go = (tab: "providers" | "mcp" | "threads" | "settings" | "env") => void

export function OverviewPage({ go }: { go: Go }) {
  const { data, error, reload } = useApi<Overview>("/api/overview", 15000)

  return (
    <>
      <PageHeader title="Overview" subtitle="Everything your bot is running on, at a glance." />
      <ErrorBanner error={error} onRetry={reload} />
      {!data ? (
        <Skeleton rows={4} />
      ) : (
        <>
          <section className="hero card">
            <div className="hero-glow" />
            <div className="hero-main">
              <div className="hero-label">Bot</div>
              <div className="hero-title">{data.bot ? `@${data.bot.username}` : "Telegram unreachable"}</div>
              <div className="hero-meta">
                {data.bot ? <Badge tone="ok" pulse>online</Badge> : <Badge tone="error">offline</Badge>}
                <ThreadBadge data={data} />
                <span className="muted">up {duration(data.uptime)} · bun {data.version}</span>
              </div>
            </div>
            <div className="hero-side">
              <div className="kv">
                <span>Default model</span>
                <code>{data.defaultModel ?? "auto"}</code>
              </div>
              <div className="kv">
                <span>Default agent</span>
                <code>{data.defaultAgent ?? "build"}</code>
              </div>
              <div className="kv">
                <span>Allowed users</span>
                <code>{data.allowedUsers.length ? data.allowedUsers.join(", ") : "nobody yet"}</code>
              </div>
            </div>
          </section>

          {data.allowedUsers.length === 0 && (
            <div className="banner banner-warn">
              <span>No Telegram users are allowed yet, so the bot ignores everyone.</span>
              <button className="link" onClick={() => go("settings")}>
                Add your user ID →
              </button>
            </div>
          )}
          {data.models === 0 && (
            <div className="banner banner-warn">
              <span>No models available. Connect a provider to start chatting.</span>
              <button className="link" onClick={() => go("providers")}>
                Connect one →
              </button>
            </div>
          )}

          <div className="stats">
            <Stat label="Models" value={data.models} onClick={() => go("settings")} />
            <Stat label="Providers" value={data.providers.length} onClick={() => go("providers")} />
            <Stat
              label="MCP servers"
              value={data.mcp.length}
              detail={`${data.mcp.filter((m) => m.status === "connected").length} connected`}
              onClick={() => go("mcp")}
            />
            <Stat label="Conversations" value={data.conversations} onClick={() => go("threads")} />
          </div>

          <OpenCodeCard />

          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h3>Connected providers</h3>
                <button className="link" onClick={() => go("providers")}>
                  Manage →
                </button>
              </div>
              {data.providers.length === 0 ? (
                <p className="muted">None yet.</p>
              ) : (
                <ul className="bars">
                  {data.providers
                    .toSorted((a, b) => b.models - a.models)
                    .map((p) => (
                      <li key={p.id}>
                        <span className="bar-label">{p.name}</span>
                        <span className="bar">
                          <span style={{ width: `${Math.max(4, (p.models / Math.max(...data.providers.map((x) => x.models), 1)) * 100)}%` }} />
                        </span>
                        <span className="bar-value">{p.models}</span>
                      </li>
                    ))}
                </ul>
              )}
            </section>
            <section className="card">
              <div className="card-head">
                <h3>MCP servers</h3>
                <button className="link" onClick={() => go("mcp")}>
                  Manage →
                </button>
              </div>
              {data.mcp.length === 0 ? (
                <p className="muted">No MCP servers configured.</p>
              ) : (
                <ul className="list-plain">
                  {data.mcp.map((m) => (
                    <li key={m.name}>
                      <span className="mono">{m.name}</span>
                      <McpBadge status={m.status} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </>
  )
}

function OpenCodeCard() {
  const { data } = useApi<OpenCodeStatus>("/api/opencode", 15000)
  const { busy, run } = useAction()
  return (
    <section className="card">
      <div className="card-head">
        <h3>OpenCode</h3>
        <Button size="sm" busy={!!busy} disabled={data?.status !== "running"} onClick={() => void run("open", openOpenCode)}>
          Open web UI ↗
        </Button>
      </div>
      <p className="muted">
        The server running every conversation. Its web UI shows the same sessions, files and terminal, which helps when debugging.
      </p>
      {data && (
        <div className="opencode-meta">
          <OpenCodeBadge status={data.status} />
          <code>{data.url}</code>
          {data.version && <span className="muted">v{data.version}</span>}
          {data.uptime !== null && <span className="muted">up {duration(data.uptime)}</span>}
          {data.restarts > 0 && <span className="muted">{data.restarts} crash restart{data.restarts === 1 ? "" : "s"}</span>}
        </div>
      )}
    </section>
  )
}

function OpenCodeBadge({ status }: { status: OpenCodeStatus["status"] }) {
  if (status === "running") return <Badge tone="ok">running</Badge>
  if (status === "stopped") return <Badge tone="error">stopped</Badge>
  return (
    <Badge tone="warn" pulse>
      {status}
    </Badge>
  )
}

function ThreadBadge({ data }: { data: Overview }) {
  if (data.threadMode === "off") return <Badge>threads off</Badge>
  if (data.bot?.topics) return <Badge tone="accent">threaded mode</Badge>
  return <Badge tone="warn">threads need BotFather “Threaded Mode”</Badge>
}

export function McpBadge({ status }: { status: string }) {
  const tone = status === "connected" ? "ok" : status === "failed" ? "error" : status === "needs_auth" || status === "pending" ? "warn" : "neutral"
  return (
    <Badge tone={tone} pulse={status === "pending"}>
      {status.replace("_", " ")}
    </Badge>
  )
}

function Stat({ label, value, detail, onClick }: { label: string; value: number; detail?: string; onClick?: () => void }) {
  return (
    <button className="stat card" onClick={onClick}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {detail && <span className="stat-detail">{detail}</span>}
    </button>
  )
}
