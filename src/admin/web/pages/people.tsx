import { useState } from "react"
import { api, enc, type MemoryInfo, type MemoryMode, type PeopleResponse, type PersonInfo, type ThreadRow, type ToolCallsResponse } from "../api"
import { Badge, Button, Confirm, Empty, ErrorBanner, Field, Initials, Modal, PageHeader, relTime, Segmented, Skeleton, useAction, useApi } from "../ui"
import { MEMORY_MODE_OPTIONS } from "./personas"
import { ToolCard } from "./threads"

const SOURCE_LABEL: Record<MemoryInfo["source"], string> = { agent: "by the bot", user: "by them", admin: "by you" }

export function PeoplePage() {
  const { data, error, reload } = useApi<PeopleResponse>("/api/people", 15_000)
  return (
    <>
      <PageHeader
        title="People"
        subtitle="Everyone who has written to the bot, with their persona and what it remembers about them. People can also change these themselves with /persona and /memory."
      />
      <ErrorBanner error={error} onRetry={reload} />
      {!data ? (
        <Skeleton rows={3} />
      ) : data.people.length === 0 ? (
        <Empty icon="☺" title="Nobody yet">
          People show up here after their first message.
        </Empty>
      ) : (
        <div className="mcp-list">
          {data.people.map((p) => (
            <PersonCard key={p.id} person={p} data={data} reload={reload} />
          ))}
        </div>
      )}
    </>
  )
}

function PersonCard({ person: p, data, reload }: { person: PersonInfo; data: PeopleResponse; reload: () => Promise<void> }) {
  const { busy, run } = useAction()
  const [draft, setDraft] = useState("")
  const [preview, setPreview] = useState<string>()
  const name = p.name || (p.username ? `@${p.username}` : `User ${p.id}`)
  const defaultPersona = data.personas.find((x) => x.id === data.defaultPersonaId)
  const defaultMode = MEMORY_MODE_OPTIONS.find((o) => o.value === data.defaultMemoryMode)!
  const mode = p.memoryMode ?? "default"

  const update = (body: { personaId?: number | null; memoryMode?: MemoryMode | null }) => run("update", () => api("PUT", `/api/people/${p.id}`, body).then(reload), "Saved")
  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    const ok = await run("add", () => api("POST", `/api/people/${p.id}/memories`, { text: draft }).then(reload).then(() => true))
    if (ok) setDraft("")
  }
  const showPrompt = () => run("prompt", () => api<{ prompt: string }>("GET", `/api/people/${p.id}/prompt`).then((r) => setPreview(r.prompt)))

  return (
    <article className="card schedule-card">
      <div className="schedule-head">
        <div className="persona-title">
          <Initials name={name} seed={String(p.id)} />
          <strong>{name}</strong>
          {p.username && p.name && <span className="muted small">@{p.username}</span>}
          <span className="mono muted small">{p.id}</span>
          {!p.allowed && <Badge tone="warn">not on the allowlist</Badge>}
          <span className="muted small">{p.seenAt ? `last message ${relTime(p.seenAt)}` : "hasn't written yet"}</span>
        </div>
        <Button size="sm" variant="ghost" busy={busy === "prompt"} onClick={showPrompt}>
          Preview prompt
        </Button>
      </div>

      <div className="grid-2">
        <Field label="Persona">
          <select className="input" disabled={!!busy} value={p.personaId ?? ""} onChange={(e) => update({ personaId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Default ({defaultPersona?.name ?? "none"})</option>
            {data.personas.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Memory" hint={(MEMORY_MODE_OPTIONS.find((o) => o.value === p.memoryMode) ?? defaultMode).hint}>
          <Segmented
            value={mode as MemoryMode | "default"}
            onChange={(v) => update({ memoryMode: v === "default" ? null : v })}
            options={[{ value: "default" as const, label: `Default (${defaultMode.label})` }, ...MEMORY_MODE_OPTIONS]}
          />
        </Field>
      </div>

      <div className="stack">
        <div className="card-head memory-head">
          <h3>
            Memories <span className="muted small">{p.memories.length}</span>
          </h3>
          {p.memories.length > 0 && (
            <Confirm text={`Forget all ${p.memories.length}?`} onConfirm={() => run("clear", () => api("DELETE", `/api/people/${p.id}/memories`).then(reload), "Forgotten")}>
              {(ask) => (
                <Button size="sm" variant="ghost" busy={busy === "clear"} onClick={ask}>
                  Forget all
                </Button>
              )}
            </Confirm>
          )}
        </div>
        {p.memories.length === 0 ? (
          <p className="muted small">Nothing remembered yet.</p>
        ) : (
          <div className="skill-list memory-list">
            {p.memories.map((m) => (
              <MemoryRow key={m.id} memory={m} reload={reload} />
            ))}
          </div>
        )}
        <form className="env-inline" onSubmit={add}>
          <input className="input" maxLength={500} placeholder="Add a memory, e.g. Has a dog called Bram" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button type="submit" busy={busy === "add"} disabled={!draft.trim()}>
            Add
          </Button>
        </form>
      </div>

      <Conversations userId={p.id} />

      {preview !== undefined && (
        <Modal wide title={`System prompt for ${name}`} subtitle="What the bot adds to OpenCode's own system prompt in this person's conversations, as of now." onClose={() => setPreview(undefined)}>
          <pre className="code" style={{ whiteSpace: "pre-wrap", maxHeight: "65vh" }}>
            {preview}
          </pre>
        </Modal>
      )}
    </article>
  )
}

function MemoryRow({ memory: m, reload }: { memory: MemoryInfo; reload: () => Promise<void> }) {
  const { busy, run } = useAction()
  const [text, setText] = useState<string>()
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const ok = await run("save", () => api("PUT", `/api/memories/${m.id}`, { text }).then(reload).then(() => true))
    if (ok) setText(undefined)
  }
  return (
    <div className="skill-row enabled">
      <div className="skill-info">
        {text === undefined ? (
          <>
            <div>{m.text}</div>
            <div className="muted small">
              <span className="mono">#{m.id}</span> · saved {SOURCE_LABEL[m.source]} {relTime(m.createdAt)}
              {m.updatedAt !== m.createdAt && ` · edited ${relTime(m.updatedAt)}`}
            </div>
          </>
        ) : (
          <form className="env-inline" onSubmit={save}>
            <input className="input" autoFocus maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
            <Button size="sm" type="submit" busy={busy === "save"} disabled={!text.trim()}>
              Save
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setText(undefined)}>
              Cancel
            </Button>
          </form>
        )}
      </div>
      {text === undefined && (
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => setText(m.text)}>
            Edit
          </Button>
          <Confirm text="Forget?" onConfirm={() => run("rm", () => api("DELETE", `/api/memories/${m.id}`).then(reload))}>
            {(ask) => (
              <Button size="sm" variant="ghost" busy={busy === "rm"} onClick={ask}>
                Forget
              </Button>
            )}
          </Confirm>
        </div>
      )}
    </div>
  )
}

function Conversations({ userId }: { userId: number }) {
  const { data, error, reload } = useApi<ThreadRow[]>(`/api/people/${userId}/threads`)
  const [open, setOpen] = useState<string>()
  return (
    <div className="stack">
      <div className="card-head memory-head">
        <h3>
          Conversations <span className="muted small">{data?.length ?? ""}</span>
        </h3>
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {!data ? (
        <Skeleton rows={1} />
      ) : data.length === 0 ? (
        <p className="muted small">No conversations yet.</p>
      ) : (
        <div className="skill-list memory-list">
          {data.map((t) => (
            <div key={t.sessionID} className="convo">
              <button className="convo-head" onClick={() => setOpen((o) => (o === t.sessionID ? undefined : t.sessionID))}>
                <span className={`collapsible-chev ${open === t.sessionID ? "open" : ""}`}>›</span>
                <span className="convo-title">{t.title || "Untitled conversation"}</span>
                {t.busy && <Badge tone="accent" pulse>running</Badge>}
                <span className="muted small">{t.threadId ? `topic ${t.threadId}` : "main chat"}</span>
                {t.model && <span className="mono muted small">{t.model}</span>}
                {t.cost > 0 && <span className="mono muted small">${t.cost.toFixed(3)}</span>}
                <span className="muted small convo-time">{relTime(t.updatedAt)}</span>
              </button>
              {open === t.sessionID && <ToolCalls sessionID={t.sessionID} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ToolCalls({ sessionID }: { sessionID: string }) {
  const { data, error, reload } = useApi<ToolCallsResponse>(`/api/threads/${enc(sessionID)}/tools`)
  return (
    <div className="convo-body">
      <ErrorBanner error={error} onRetry={reload} />
      {!data ? (
        <Skeleton rows={2} />
      ) : (
        <>
          <div className="row convo-tally">
            <span className="muted small">
              {data.total === 0 ? "No tool calls." : `${data.total} tool call${data.total === 1 ? "" : "s"}${data.partial ? " in the latest 1000 messages" : ""}`}
            </span>
            <a className="link small" href={`#threads/${enc(sessionID)}`}>
              Open conversation →
            </a>
          </div>
          {data.tally.length > 0 && (
            <div className="chips">
              {data.tally.map((t) => (
                <span key={t.name} className="chip chip-static" title={t.errors ? `${t.errors} failed` : undefined}>
                  <span className="mono">{t.name}</span> {t.count}
                  {t.errors > 0 && <span className="error-text"> · {t.errors} failed</span>}
                </span>
              ))}
            </div>
          )}
          <div className="convo-calls">
            {data.calls.map((c) => (
              <ToolCard key={c.part.id} part={c.part} inner={c.inner} />
            ))}
            {data.calls.length < data.total && <p className="muted small">Showing the latest {data.calls.length}. Open the conversation for the rest.</p>}
          </div>
        </>
      )}
    </div>
  )
}
