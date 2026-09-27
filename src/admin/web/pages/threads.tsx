import { useMemo, useState } from "react"
import type { ThreadRow } from "../api"
import { Badge, Empty, ErrorBanner, PageHeader, relTime, Skeleton, useApi } from "../ui"

export function ThreadsPage() {
  const { data, error, reload } = useApi<ThreadRow[]>("/api/threads", 20000)
  const [query, setQuery] = useState("")

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data ?? []).filter((r) => !q || [r.title, r.model, r.agent, String(r.chatId), r.sessionID].some((v) => v?.toLowerCase().includes(q)))
  }, [data, query])

  const totals = useMemo(
    () => (data ?? []).reduce((acc, r) => ({ cost: acc.cost + r.cost, tokens: acc.tokens + r.tokens }), { cost: 0, tokens: 0 }),
    [data],
  )

  return (
    <>
      <PageHeader
        title="Conversations"
        subtitle={data ? `${data.length} threads · ${formatTokens(totals.tokens)} tokens · $${totals.cost.toFixed(2)}` : "Every Telegram thread and the OpenCode session behind it."}
      />
      <ErrorBanner error={error} onRetry={reload} />
      <div className="toolbar">
        <div className="search">
          <span className="search-icon">⌕</span>
          <input className="input" placeholder="Filter by title, model, chat…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      {!data ? (
        <Skeleton rows={5} />
      ) : rows.length === 0 ? (
        <Empty icon="✦" title={data.length ? "Nothing matches" : "No conversations yet"}>
          {data.length ? "Try another filter." : "Message the bot on Telegram to start one."}
        </Empty>
      ) : (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Conversation</th>
                <th>Where</th>
                <th>Model</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th className="num">Active</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.chatId}:${r.threadId}`}>
                  <td>
                    <div className="thread-title">{r.title || <span className="muted">Untitled</span>}</div>
                    <div className="mono muted small">{r.sessionID}</div>
                  </td>
                  <td>
                    <div className="mono small">{r.chatId}</div>
                    {r.threadId ? <Badge tone="accent">topic #{r.threadId}</Badge> : <Badge>main chat</Badge>}
                  </td>
                  <td>
                    <div className="mono small">{r.model ?? "—"}</div>
                    {r.agent && <div className="muted small">{r.agent}</div>}
                  </td>
                  <td className="num mono">{formatTokens(r.tokens)}</td>
                  <td className="num mono">${r.cost.toFixed(r.cost < 1 ? 3 : 2)}</td>
                  <td className="num muted small">{relTime(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
