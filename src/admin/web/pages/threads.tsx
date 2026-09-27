import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { api, enc, stream, type AssistantPart, type ChatMessage, type Conversation, type SettingsResponse, type ThreadRow, type ToolState } from "../api"
import { CodeBlock, Markdown } from "../markdown"
import { Badge, Button, Empty, ErrorBanner, Modal, relTime, Skeleton, useAction, useApi, useToast } from "../ui"

type Assistant = Extract<ChatMessage, { type: "assistant" }>
type Local = { id: string; text: string; time: number }
type Live = { type: string; data: Record<string, any> }

const REFETCH_EVENTS = new Set([
  "session.inbox.delivered",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.model.selected",
  "session.agent.selected",
  "session.synthetic",
  "session.shell.started",
  "session.shell.ended",
  "session.skill.activated",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.message.content.updated",
  "session.revert.committed",
])

export function ThreadsPage({ selected, open }: { selected?: string; open: (sessionID?: string) => void }) {
  const { data, error, reload } = useApi<ThreadRow[]>("/api/threads", 8000)
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data ?? []).filter((r) => !q || [r.title, r.model, r.agent, String(r.chatId), r.sessionID].some((v) => v?.toLowerCase().includes(q)))
  }, [data, query])

  const totals = useMemo(() => (data ?? []).reduce((acc, r) => ({ cost: acc.cost + r.cost, tokens: acc.tokens + r.tokens }), { cost: 0, tokens: 0 }), [data])

  useEffect(() => {
    if (!selected && data?.[0] && window.matchMedia("(min-width: 901px)").matches) open(data[0].sessionID)
  }, [selected, data, open])

  return (
    <div className={`chat-layout ${selected ? "has-selection" : ""}`}>
      <aside className="chat-list">
        <div className="chat-list-head">
          <div>
            <h2>Conversations</h2>
            <p className="muted small">{data ? `${data.length} threads · ${formatTokens(totals.tokens)} tok · $${totals.cost.toFixed(2)}` : "Loading…"}</p>
          </div>
          <Button size="sm" variant="primary" onClick={() => setCreating(true)} disabled={!data?.length} title="Start a new conversation">
            + New
          </Button>
        </div>
        <div className="search">
          <span className="search-icon">⌕</span>
          <input className="input" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <ErrorBanner error={error} onRetry={reload} />
        <div className="chat-list-items">
          {!data ? (
            <Skeleton rows={6} />
          ) : rows.length === 0 ? (
            <Empty icon="✦" title={data.length ? "Nothing matches" : "No conversations yet"}>
              {data.length ? "Try another filter." : "Message the bot on Telegram to start one."}
            </Empty>
          ) : (
            rows.map((r) => (
              <button key={r.sessionID} className={`chat-item ${selected === r.sessionID ? "active" : ""}`} onClick={() => open(r.sessionID)}>
                <div className="chat-item-top">
                  <span className="chat-item-title">{r.title || <span className="muted">Untitled</span>}</span>
                  <span className="chat-item-time">{r.busy ? <span className="live-dot" title="Running" /> : relTime(r.updatedAt)}</span>
                </div>
                <div className="chat-item-meta">
                  <span className={`chat-where ${r.threadId ? "topic" : ""}`}>{r.threadId ? `# ${r.threadId}` : "main"}</span>
                  <span className="mono">{shortModel(r.model)}</span>
                  <span className="chat-item-cost mono">${r.cost.toFixed(r.cost < 1 ? 3 : 2)}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>
      <section className="chat-pane">
        {selected ? (
          <ChatPane key={selected} sessionID={selected} onBack={() => open()} onActivity={reload} />
        ) : (
          <div className="chat-placeholder">
            <Empty icon="💬" title="Pick a conversation">
              Every Telegram thread, live. Reply from here and it shows up in Telegram too.
            </Empty>
          </div>
        )}
      </section>
      {creating && data && (
        <NewConversation
          threads={data}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            void reload()
            open(id)
          }}
        />
      )}
    </div>
  )
}

function NewConversation({ threads, onClose, onCreated }: { threads: ThreadRow[]; onClose: () => void; onCreated: (sessionID: string) => void }) {
  const chats = useMemo(() => [...new Set(threads.map((t) => t.chatId))], [threads])
  const [chatId, setChatId] = useState(chats[0]!)
  const { busy, run } = useAction()
  const submit = async () => {
    const res = await run("create", () => api<{ sessionID: string }>("POST", "/api/threads", { chatId }), "Conversation started")
    if (res) onCreated(res.sessionID)
  }
  return (
    <Modal title="New conversation" subtitle="Opens a fresh Telegram topic when the chat has threads, otherwise starts a new session in place." onClose={onClose}>
      <div className="stack">
        <div className="chips">
          {chats.map((id) => (
            <button key={id} className={`chip ${id === chatId ? "active" : ""}`} onClick={() => setChatId(id)}>
              <span className="mono">{id}</span>
              <span className="muted small">{id > 0 ? "private" : "group"}</span>
            </button>
          ))}
        </div>
        <div className="row-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy === "create"} onClick={submit}>
            Start conversation
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ChatPane({ sessionID, onBack, onActivity }: { sessionID: string; onBack: () => void; onActivity: () => void }) {
  const toast = useToast()
  const [conv, setConv] = useState<Conversation>()
  const [error, setError] = useState<string>()
  const [locals, setLocals] = useState<Local[]>([])
  const [live, setLive] = useState<"connecting" | "live" | "offline">("connecting")
  const [loadingOlder, setLoadingOlder] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const refetchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const path = `/api/threads/${enc(sessionID)}`

  const refresh = useCallback(async () => {
    try {
      const fresh = await api<Conversation>("GET", path)
      setConv((prev) => (prev ? { ...fresh, messages: mergeMessages(prev.messages, fresh.messages), older: prev.older } : fresh))
      setLocals((ls) => ls.filter((l) => !fresh.messages.some((m) => m.type === "user" && m.text === l.text && m.time.created >= l.time - 5000)))
      setError(undefined)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [path])

  const scheduleRefresh = useCallback(() => {
    clearTimeout(refetchTimer.current)
    refetchTimer.current = setTimeout(() => void refresh(), 250)
  }, [refresh])

  useEffect(() => {
    void refresh()
    return () => clearTimeout(refetchTimer.current)
  }, [refresh])

  useEffect(() => {
    const ctrl = new AbortController()
    let attempt = 0
    const connect = async () => {
      while (!ctrl.signal.aborted) {
        try {
          await stream(
            `${path}/events`,
            (event, data) => {
              if (event === "ready") {
                attempt = 0
                setLive("live")
                // Catch up on anything missed while disconnected.
                scheduleRefresh()
                return
              }
              const e = data as Live
              if (REFETCH_EVENTS.has(e.type)) scheduleRefresh()
              if (e.type.startsWith("session.execution.") && e.type !== "session.execution.started") onActivity()
              setConv((c) => (c ? applyEvent(c, e) : c))
            },
            ctrl.signal,
          )
        } catch {
          if (ctrl.signal.aborted) return
        }
        setLive("offline")
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt++, 15000)))
        setLive("connecting")
      }
    }
    void connect()
    return () => ctrl.abort()
  }, [path, scheduleRefresh, onActivity])

  const onScroll = () => {
    const el = scroller.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  const loadOlder = async () => {
    if (!conv?.older) return
    const el = scroller.current
    const before = el ? el.scrollHeight - el.scrollTop : 0
    setLoadingOlder(true)
    try {
      const page = await api<Conversation>("GET", `${path}?cursor=${enc(conv.older)}`)
      stick.current = false
      setConv((c) => (c ? { ...c, messages: mergeMessages(page.messages, c.messages), older: page.older } : c))
      requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - before))
    } catch (err) {
      toast("error", (err as Error).message)
    } finally {
      setLoadingOlder(false)
    }
  }

  const send = async (text: string) => {
    const local = { id: `local-${Date.now()}`, text, time: Date.now() }
    setLocals((ls) => [...ls, local])
    stick.current = true
    try {
      await api("POST", `${path}/prompt`, { text })
      onActivity()
      return true
    } catch (err) {
      setLocals((ls) => ls.filter((l) => l.id !== local.id))
      toast("error", (err as Error).message)
      return false
    }
  }

  if (!conv) {
    return (
      <div className="chat-loading">
        {error ? <ErrorBanner error={error} onRetry={refresh} /> : <Skeleton rows={4} />}
      </div>
    )
  }

  return (
    <>
      <ChatHeader conv={conv} live={live} onBack={onBack} onChanged={refresh} />
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat-thread">
          {conv.older && (
            <div className="chat-older">
              <Button size="sm" variant="ghost" busy={loadingOlder} onClick={loadOlder}>
                Load earlier messages
              </Button>
            </div>
          )}
          {conv.messages.length === 0 && locals.length === 0 && (
            <Empty icon="✧" title="No messages yet">
              Say something below, or message the bot in Telegram.
            </Empty>
          )}
          <Timeline messages={conv.messages} busy={conv.busy} />
          {locals.map((l) => (
            <UserBubble key={l.id} text={l.text} time={l.time} pending />
          ))}
          {conv.busy && !lastIsStreaming(conv.messages) && <Thinking />}
        </div>
      </div>
      <Composer busy={conv.busy} onSend={send} onStop={() => api("POST", `${path}/stop`).then(() => toast("info", "Stopping…"), (e) => toast("error", e.message))} />
    </>
  )
}

function ChatHeader({ conv, live, onBack, onChanged }: { conv: Conversation; live: "connecting" | "live" | "offline"; onBack: () => void; onChanged: () => Promise<void> }) {
  const { session, key } = conv
  const link = key ? telegramLink(key, conv.bot) : null
  const tokens = session.tokens.input + session.tokens.output
  return (
    <header className="chat-head">
      <button className="icon-btn chat-back" onClick={onBack} aria-label="Back">
        ←
      </button>
      <div className="chat-head-main">
        <div className="chat-head-title">
          <h2>{session.title || "Untitled conversation"}</h2>
          {conv.busy ? (
            <Badge tone="accent" pulse>
              running
            </Badge>
          ) : (
            <Badge tone={live === "live" ? "ok" : live === "offline" ? "error" : "warn"} pulse={live === "live"}>
              {live}
            </Badge>
          )}
        </div>
        <div className="chat-head-meta">
          {key && (
            <span className="mono">
              {key.chatId}
              {key.threadId ? ` · topic ${key.threadId}` : " · main chat"}
            </span>
          )}
          <span>{formatTokens(tokens)} tokens</span>
          {session.tokens.cache.read > 0 && <span>{formatTokens(session.tokens.cache.read)} cached</span>}
          <span className="mono">${session.cost.toFixed(4)}</span>
          <span>started {relTime(session.created)}</span>
        </div>
      </div>
      <div className="chat-head-actions">
        <SessionPickers conv={conv} onChanged={onChanged} />
        {link && (
          <a className="btn btn-sm" href={link} target="_blank" rel="noreferrer" title="Open in Telegram">
            ✈ Telegram
          </a>
        )}
      </div>
    </header>
  )
}

function SessionPickers({ conv, onChanged }: { conv: Conversation; onChanged: () => Promise<void> }) {
  const [lists, setLists] = useState<SettingsResponse>()
  const [open, setOpen] = useState<"model" | "agent">()
  const [query, setQuery] = useState("")
  const { busy, run } = useAction()
  const box = useRef<HTMLDivElement>(null)
  const path = `/api/threads/${enc(conv.session.id)}`

  useEffect(() => {
    if (!open) return
    if (!lists) void api<SettingsResponse>("GET", "/api/settings").then(setLists, () => {})
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(undefined)
    window.addEventListener("mousedown", onDown)
    return () => window.removeEventListener("mousedown", onDown)
  }, [open, lists])

  const pick = async (kind: "model" | "agent", value: string) => {
    setOpen(undefined)
    setQuery("")
    const ok = await run(kind, () => api("PUT", `${path}/${kind}`, kind === "model" ? { ref: value } : { agent: value }), kind === "model" ? `Model → ${value}` : `Agent → ${value}`)
    if (ok !== undefined) await onChanged()
  }

  const q = query.toLowerCase()
  const models = (lists?.models ?? []).filter((m) => !q || m.ref.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)).slice(0, 60)

  return (
    <div className="pickers" ref={box}>
      <Button size="sm" busy={busy === "model"} onClick={() => setOpen(open === "model" ? undefined : "model")} title={conv.session.model ?? "default model"}>
        🧠 <span className="mono">{shortModel(conv.session.model)}</span>
      </Button>
      <Button size="sm" busy={busy === "agent"} onClick={() => setOpen(open === "agent" ? undefined : "agent")}>
        🤖 {conv.session.agent ?? "default"}
      </Button>
      {open && (
        <div className="combo-pop picker-pop">
          {open === "model" && <input autoFocus className="input" placeholder="Search models…" value={query} onChange={(e) => setQuery(e.target.value)} />}
          <ul>
            {!lists && <li className="muted small combo-empty">Loading…</li>}
            {open === "model" &&
              models.map((m) => (
                <li key={m.ref}>
                  <button className={m.ref === conv.session.model ? "active" : ""} onClick={() => pick("model", m.ref)}>
                    <span>{m.name}</span>
                    <span className="mono muted small">{m.ref}</span>
                  </button>
                </li>
              ))}
            {open === "agent" &&
              lists?.agents.map((a) => (
                <li key={a.id}>
                  <button className={a.id === conv.session.agent ? "active" : ""} onClick={() => pick("agent", a.id)}>
                    <span>{a.name}</span>
                    {a.description && <span className="muted small">{a.description}</span>}
                  </button>
                </li>
              ))}
            {lists && open === "model" && models.length === 0 && <li className="muted small combo-empty">No models match.</li>}
          </ul>
        </div>
      )}
    </div>
  )
}

function Composer({ busy, onSend, onStop }: { busy: boolean; onSend: (text: string) => Promise<boolean>; onStop: () => void }) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const submit = async () => {
    const value = text.trim()
    if (!value || sending) return
    setSending(true)
    setText("")
    if (!(await onSend(value))) setText(value)
    setSending(false)
    area.current?.focus()
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={area}
          rows={1}
          placeholder={busy ? "Queue a follow-up…" : "Message the agent…  (Enter to send, Shift+Enter for newline)"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div className="composer-actions">
          {busy && (
            <Button size="sm" variant="ghost" onClick={onStop} title="Interrupt the current run">
              ■ Stop
            </Button>
          )}
          <Button size="sm" variant="primary" busy={sending} disabled={!text.trim()} onClick={submit}>
            {busy ? "Queue" : "Send"} ↵
          </Button>
        </div>
      </div>
      <p className="composer-hint">Mirrored to Telegram with a 💻 tag, so the reply shows up in both places.</p>
    </div>
  )
}

type Item = { kind: "message"; message: ChatMessage } | { kind: "turn"; steps: Assistant[] }

function Timeline({ messages, busy }: { messages: ChatMessage[]; busy: boolean }) {
  const items = useMemo(() => {
    const out: Item[] = []
    for (const m of messages) {
      if (m.type === "system" || m.type === "location-switched") continue
      if (m.type === "idle" && m.outcome === "succeeded") continue
      const last = out[out.length - 1]
      if (m.type === "assistant" && last?.kind === "turn") last.steps.push(m)
      else if (m.type === "assistant") out.push({ kind: "turn", steps: [m] })
      else out.push({ kind: "message", message: m })
    }
    return out
  }, [messages])

  return (
    <>
      {items.map((it, i) =>
        it.kind === "turn" ? (
          <AssistantTurn key={it.steps[0]!.id} steps={it.steps} streaming={busy && i === items.length - 1} />
        ) : (
          <MessageRow key={it.message.id} message={it.message} />
        ),
      )}
    </>
  )
}

function MessageRow({ message: m }: { message: ChatMessage }) {
  switch (m.type) {
    case "user":
      return <UserBubble text={m.text} time={m.time.created} files={m.files} />
    case "model-switched":
      return <Notice icon="🧠">Model → <span className="mono">{`${m.model.providerID}/${m.model.id}`}</span></Notice>
    case "agent-switched":
      return <Notice icon="🤖">Agent → {m.agent}</Notice>
    case "idle":
      return <Notice icon={m.outcome === "failed" ? "⚠️" : "⏹"} tone={m.outcome === "failed" ? "error" : undefined}>{m.outcome === "failed" ? "Run failed" : "Stopped"}</Notice>
    case "compaction":
      return <Notice icon="🗜">{m.status === "failed" ? "Compaction failed" : m.status === "running" ? "Compacting context…" : "Context compacted"}</Notice>
    case "synthetic":
    case "skill":
      return (
        <Collapsible className="notice-card" summary={<><span>{m.type === "skill" ? "📚" : "✳"}</span> {m.type === "skill" ? `Skill: ${m.name}` : m.description || "Injected context"}</>}>
          <pre className="plain">{m.text}</pre>
        </Collapsible>
      )
    case "shell":
      return (
        <div className="tool-card">
          <Collapsible summary={<ToolSummary icon="$" name="shell" label={m.command} status={m.status === "running" ? "running" : m.status === "exited" && Number(m.exit) === 0 ? "ok" : "error"} />}>
            {m.output?.output ? <CodeBlock lang="output" text={m.output.output} /> : <p className="muted small">No output.</p>}
          </Collapsible>
        </div>
      )
    default:
      return null
  }
}

function UserBubble({ text, time, files, pending }: { text: string; time: number; files?: { name: string | null; mime: string; preview: string | null }[]; pending?: boolean }) {
  return (
    <div className={`msg msg-user ${pending ? "pending" : ""}`}>
      <div className="bubble">
        {files && files.length > 0 && (
          <div className="attachments">
            {files.map((f, i) =>
              f.preview ? (
                <a key={i} href={f.preview} target="_blank" rel="noreferrer">
                  <img src={f.preview} alt={f.name ?? "image"} />
                </a>
              ) : (
                <span key={i} className="file-chip">
                  📎 {f.name ?? f.mime}
                </span>
              ),
            )}
          </div>
        )}
        {text && <div className="bubble-text">{text}</div>}
      </div>
      <div className="msg-meta">{pending ? "sending…" : clock(time)}</div>
    </div>
  )
}

function AssistantTurn({ steps, streaming }: { steps: Assistant[]; streaming: boolean }) {
  const last = steps[steps.length - 1]!
  const cost = steps.reduce((s, m) => s + (m.cost ?? 0), 0)
  const out = steps.reduce((s, m) => s + (m.tokens?.output ?? 0), 0)
  const input = last.tokens ? last.tokens.input + last.tokens.cache.read : 0
  const end = last.time.completed
  const took = end ? end - steps[0]!.time.created : undefined
  const parts = steps.flatMap((m) => m.content.map((p, i) => ({ part: p, key: `${m.id}:${i}` })))
  const errors = steps.filter((m) => m.error)
  return (
    <div className="msg msg-assistant">
      <div className="assistant-avatar">
        <span />
      </div>
      <div className="assistant-body">
        {parts.map(({ part, key }, i) => (
          <Part key={key} part={part} streaming={streaming && i === parts.length - 1} />
        ))}
        {last.retry && (
          <div className="callout callout-warn small">
            ⏳ Retrying (attempt {last.retry.attempt}): {last.retry.error.message}
          </div>
        )}
        {errors.map((m) => (
          <div key={m.id} className="callout callout-error small">
            ⚠️ {m.error!.message}
          </div>
        ))}
        <div className="msg-meta assistant-meta">
          <span className="mono">{`${last.model.providerID}/${last.model.id}`}</span>
          <span>{last.agent}</span>
          {input > 0 && <span>{formatTokens(input)} ctx</span>}
          {out > 0 && <span>{formatTokens(out)} out</span>}
          {cost > 0 && <span className="mono">${cost.toFixed(4)}</span>}
          {took !== undefined && !streaming && <span>{(took / 1000).toFixed(1)}s</span>}
          <span>{clock(steps[0]!.time.created)}</span>
        </div>
      </div>
    </div>
  )
}

function Part({ part, streaming }: { part: AssistantPart; streaming: boolean }) {
  if (part.type === "text") {
    if (!part.text.trim()) return streaming ? <Thinking inline /> : null
    return (
      <div className={`assistant-text ${streaming ? "streaming" : ""}`}>
        <Markdown text={part.text} />
      </div>
    )
  }
  if (part.type === "reasoning") {
    if (!part.text.trim() && !streaming) return null
    const secs = part.time?.completed ? Math.max(1, Math.round((part.time.completed - part.time.created) / 1000)) : undefined
    return (
      <Collapsible className="reasoning" summary={<>✧ {secs ? `Thought for ${secs}s` : "Thinking…"}</>} defaultOpen={streaming}>
        <div className="reasoning-text">{part.text}</div>
      </Collapsible>
    )
  }
  return <ToolCard part={part} />
}

function ToolCard({ part }: { part: Extract<AssistantPart, { type: "tool" }> }) {
  const s = part.state
  const status = s.status === "completed" ? "ok" : s.status === "error" ? "error" : "running"
  const input = typeof s.input === "string" ? undefined : s.input
  const took = part.time.completed && part.time.ran ? part.time.completed - part.time.ran : undefined
  return (
    <div className={`tool-card tool-${status}`}>
      <Collapsible summary={<ToolSummary icon={toolIcon(part.name)} name={part.name} label={toolLabel(input)} status={status} took={took} />}>
        <ToolDetail state={s} />
      </Collapsible>
    </div>
  )
}

function ToolSummary({ icon, name, label, status, took }: { icon: string; name: string; label: string; status: "ok" | "error" | "running"; took?: number }) {
  return (
    <>
      <span className={`tool-status ${status}`}>{status === "running" ? <span className="spinner" /> : status === "ok" ? "✓" : "✕"}</span>
      <span className="tool-icon">{icon}</span>
      <span className="tool-name">{name}</span>
      {label && <span className="tool-label mono">{label}</span>}
      {took !== undefined && <span className="tool-took">{took < 1000 ? `${took}ms` : `${(took / 1000).toFixed(1)}s`}</span>}
    </>
  )
}

function ToolDetail({ state: s }: { state: ToolState }) {
  const input = typeof s.input === "string" ? s.input : JSON.stringify(s.input, null, 2)
  const content = "content" in s ? (s.content ?? []) : []
  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
  const files = content.filter((c) => c.type === "file")
  return (
    <div className="tool-detail">
      {input && input !== "{}" && <CodeBlock lang="input" text={input} />}
      {s.status === "error" && <div className="callout callout-error small">{s.error.message}</div>}
      {text && <CodeBlock lang="output" text={text} />}
      {files.map((f, i) =>
        f.type === "file" && f.mime.startsWith("image/") && f.uri.startsWith("data:") ? (
          <img key={i} className="tool-image" src={f.uri} alt={f.name ?? ""} />
        ) : (
          <span key={i} className="file-chip">
            📎 {f.type === "file" ? (f.name ?? f.uri) : ""}
          </span>
        ),
      )}
      {s.status === "running" && !text && <p className="muted small">Running…</p>}
    </div>
  )
}

function Collapsible({ summary, children, className, defaultOpen }: { summary: React.ReactNode; children: React.ReactNode; className?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  return (
    <div className={`collapsible ${className ?? ""} ${open ? "open" : ""}`}>
      <button className="collapsible-head" onClick={() => setOpen((o) => !o)}>
        {summary}
        <span className="collapsible-chev">›</span>
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  )
}

function Notice({ icon, children, tone }: { icon: string; children: React.ReactNode; tone?: "error" }) {
  return (
    <div className={`notice ${tone ? `notice-${tone}` : ""}`}>
      <span>{icon}</span>
      <span>{children}</span>
    </div>
  )
}

function Thinking({ inline }: { inline?: boolean }) {
  return (
    <div className={inline ? "thinking inline" : "msg msg-assistant"}>
      {!inline && (
        <div className="assistant-avatar">
          <span />
        </div>
      )}
      <div className="thinking-dots">
        <span />
        <span />
        <span />
      </div>
    </div>
  )
}

/** Apply a streaming event to the loaded conversation; structural changes are picked up by a refetch. */
export function applyEvent(c: Conversation, e: Live): Conversation {
  const d = e.data
  switch (e.type) {
    case "session.execution.started":
      return { ...c, busy: true }
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return { ...c, busy: false, messages: c.messages.map((m) => (m.type === "assistant" && m.retry ? { ...m, retry: undefined } : m)) }
    case "session.renamed":
      return { ...c, session: { ...c.session, title: d.title } }
    case "session.usage.updated":
      return { ...c, session: { ...c.session, cost: d.cost, tokens: d.tokens } }
    case "session.step.started": {
      if (c.messages.some((m) => m.id === d.assistantMessageID)) {
        return updateAssistant(c, d.assistantMessageID, (m) => ({ ...m, agent: d.agent, model: d.model, error: undefined, retry: undefined }))
      }
      const msg: Assistant = { id: d.assistantMessageID, type: "assistant", agent: d.agent, model: d.model, time: { created: d.started }, content: [] }
      return { ...c, busy: true, messages: [...c.messages, msg] }
    }
    case "session.step.ended":
    case "session.step.failed":
      return updateAssistant(c, d.assistantMessageID, (m) => ({
        ...m,
        time: { ...m.time, completed: Date.now() },
        finish: d.finish ?? m.finish,
        cost: d.cost ?? m.cost,
        tokens: d.tokens ?? m.tokens,
        error: d.error ?? m.error,
        retry: undefined,
      }))
    case "session.retry.scheduled":
      return updateAssistant(c, d.assistantMessageID, (m) => ({ ...m, retry: { attempt: d.attempt, at: d.at, error: d.error } }))
    case "session.text.started":
    case "session.reasoning.started":
      return updateAssistant(c, d.assistantMessageID, (m) => ({ ...m, content: ensureFragment(m.content, e.type.includes("text") ? "text" : "reasoning", d.ordinal) }))
    case "session.text.delta":
    case "session.reasoning.delta":
    case "session.text.ended":
    case "session.reasoning.ended": {
      const kind = e.type.includes("text") ? "text" : "reasoning"
      const ended = e.type.endsWith("ended")
      return updateAssistant(c, d.assistantMessageID, (m) => {
        const content = ensureFragment(m.content, kind, d.ordinal)
        const idx = fragmentIndex(content, kind, d.ordinal)
        const part = content[idx] as Extract<AssistantPart, { type: "text" | "reasoning" }>
        const next = { ...part, text: ended ? d.text : part.text + d.delta } as AssistantPart
        if (next.type === "reasoning" && ended) next.time = { created: next.time?.created ?? Date.now(), completed: Date.now() }
        content[idx] = next
        return { ...m, content }
      })
    }
    case "session.tool.input.started":
      return updateAssistant(c, d.assistantMessageID, (m) =>
        m.content.some((p) => p.type === "tool" && p.id === d.id)
          ? m
          : { ...m, content: [...m.content, { type: "tool", id: d.id, name: d.name, state: { status: "streaming", input: "" }, time: { created: Date.now() } }] },
      )
    case "session.tool.called":
      return updateTool(c, d.assistantMessageID, d.id, (t) => ({ ...t, time: { ...t.time, ran: Date.now() }, state: { status: "running", input: d.input } }))
    case "session.tool.success":
      return updateTool(c, d.assistantMessageID, d.id, (t) => ({
        ...t,
        time: { ...t.time, completed: Date.now() },
        state: { status: "completed", input: typeof t.state.input === "string" ? {} : t.state.input, content: d.content },
      }))
    case "session.tool.failed":
      return updateTool(c, d.assistantMessageID, d.id, (t) => ({
        ...t,
        time: { ...t.time, completed: Date.now() },
        state: { status: "error", input: typeof t.state.input === "string" ? {} : t.state.input, error: d.error, content: d.content },
      }))
  }
  return c
}

function updateAssistant(c: Conversation, id: string, fn: (m: Assistant) => Assistant): Conversation {
  const idx = c.messages.findIndex((m) => m.id === id)
  const current = c.messages[idx]
  if (!current || current.type !== "assistant") return c
  const messages = [...c.messages]
  messages[idx] = fn({ ...current, content: [...current.content] })
  return { ...c, messages }
}

function updateTool(c: Conversation, messageID: string, toolID: string, fn: (t: Extract<AssistantPart, { type: "tool" }>) => AssistantPart): Conversation {
  return updateAssistant(c, messageID, (m) => ({ ...m, content: m.content.map((p) => (p.type === "tool" && p.id === toolID ? fn(p) : p)) }))
}

/** Text and reasoning fragments are numbered per step; make sure the `ordinal`-th one exists. */
function ensureFragment(content: AssistantPart[], kind: "text" | "reasoning", ordinal: number): AssistantPart[] {
  const out = [...content]
  while (out.filter((p) => p.type === kind).length <= ordinal) {
    out.push(kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "", time: { created: Date.now() } })
  }
  return out
}

function fragmentIndex(content: AssistantPart[], kind: "text" | "reasoning", ordinal: number): number {
  let n = -1
  return content.findIndex((p) => p.type === kind && ++n === ordinal)
}

/** Merge two ordered message lists, with `b` winning on conflicts. */
export function mergeMessages(a: ChatMessage[], b: ChatMessage[]): ChatMessage[] {
  const fresh = new Map(b.map((m) => [m.id, m]))
  const out = a.map((m) => fresh.get(m.id) ?? m)
  const seen = new Set(a.map((m) => m.id))
  for (const m of b) if (!seen.has(m.id)) out.push(m)
  return out.sort((x, y) => x.time.created - y.time.created || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
}

function lastIsStreaming(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1]
  return last?.type === "assistant" && !last.time.completed && last.content.length > 0
}

function toolLabel(input: Record<string, unknown> | undefined): string {
  for (const k of ["command", "filePath", "path", "pattern", "url", "query", "description", "prompt"]) {
    const v = input?.[k]
    if (typeof v === "string" && v) return v.replace(/\s+/g, " ").slice(0, 140)
  }
  return ""
}

function toolIcon(name: string): string {
  if (/bash|shell|exec/.test(name)) return "$"
  if (/read|view/.test(name)) return "◧"
  if (/write|edit|patch/.test(name)) return "✎"
  if (/grep|glob|search|find|list/.test(name)) return "⌕"
  if (/fetch|web|http/.test(name)) return "⌁"
  if (/task|agent/.test(name)) return "⧉"
  if (/todo/.test(name)) return "☑"
  return "⚙"
}

function telegramLink(key: { chatId: number; threadId: number }, bot: string | null): string | null {
  const id = String(key.chatId)
  if (id.startsWith("-100")) return `https://t.me/c/${id.slice(4)}${key.threadId ? `/${key.threadId}` : ""}`
  return bot ? `https://t.me/${bot}` : null
}

function shortModel(ref: string | null): string {
  if (!ref) return "default"
  return ref.slice(ref.indexOf("/") + 1)
}

function clock(ms: number): string {
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
