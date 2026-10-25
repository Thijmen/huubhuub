import { useEffect, useState } from "react"
import { api, enc, type AppInvite, type MemoryInfo, type MemoryMode, type PeopleResponse, type PeriodSpend, type PersonInfo, type ThreadRow, type ToolCallsResponse } from "../api"
import { money } from "../spend"
import { Badge, Button, Confirm, Empty, ErrorBanner, Field, Initials, Modal, PageHeader, relTime, Segmented, Skeleton, Toggle, useAction, useApi } from "../ui"
import { MEMORY_MODE_OPTIONS } from "./personas"
import { ToolCard } from "./threads"

const SOURCE_LABEL: Record<MemoryInfo["source"], string> = { agent: "by the bot", user: "by them", admin: "by you" }

export function PeoplePage() {
  const { data, error, reload } = useApi<PeopleResponse>("/api/people", 15_000)
  const [inviting, setInviting] = useState(false)
  return (
    <>
      <PageHeader
        title="People"
        subtitle="Everyone who uses the bot, in Telegram or the phone app: their persona, what it remembers about them, and what they may spend. People can change their persona and memory themselves with /persona and /memory, and see their spending with /costs."
        actions={
          <Button variant="primary" disabled={!data?.appEnabled} title={data && !data.appEnabled ? "Set APP_PUBLIC_URL first" : undefined} onClick={() => setInviting(true)}>
            Invite to the app
          </Button>
        }
      />
      {data && !data.appEnabled && (
        <p className="muted small">To invite people to the phone app, expose the app API (APP_PORT, default 8081) through a TLS proxy and set APP_PUBLIC_URL to that address.</p>
      )}
      {inviting && <NewAppPerson onClose={() => setInviting(false)} reload={reload} />}
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
  const name = p.name || (p.username ? `@${p.username}` : `User ${p.telegramId ?? p.id}`)
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
          {p.telegramId !== null && <span className="mono muted small">{p.telegramId}</span>}
          {p.telegramId === null && <Badge>app only</Badge>}
          {p.telegramId !== null && !p.allowed && <Badge tone="warn">not on the allowlist</Badge>}
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

      <Spending person={p} defaults={data.defaultLimits} reload={reload} />

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

      <AppAccess person={p} enabled={data.appEnabled} reload={reload} />

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

/** Phones signed in to the app, and one-time invites. */
function AppAccess({ person: p, enabled, reload }: { person: PersonInfo; enabled: boolean; reload: () => Promise<void> }) {
  const { busy, run } = useAction()
  const [invite, setInvite] = useState<AppInvite>()
  const create = () => run("invite", () => api<AppInvite>("POST", `/api/people/${p.id}/app-invite`).then((i) => (setInvite(i), reload())))
  const revoke = (id: string) => run(`revoke:${id}`, () => api("DELETE", `/api/app-devices/${enc(id)}`).then(reload), "Signed out")
  return (
    <div className="stack">
      <div className="card-head memory-head">
        <h3>
          Phone app <span className="muted small">{p.devices.length}</span>
        </h3>
        <Button size="sm" variant="ghost" busy={busy === "invite"} disabled={!enabled} onClick={create}>
          New invite
        </Button>
      </div>
      {p.devices.length === 0 ? (
        <p className="muted small">
          No phones signed in.{p.openInvites ? ` ${p.openInvites} invite${p.openInvites === 1 ? "" : "s"} not used yet.` : ""}
        </p>
      ) : (
        <div className="skill-list memory-list">
          {p.devices.map((d) => (
            <div key={d.id} className="skill-row">
              <div>
                <strong>{d.name || "Phone"}</strong> <span className="muted small">{d.platform ?? ""}</span>
                <div className="muted small">
                  Signed in {relTime(d.createdAt)}
                  {d.seenAt ? `, last seen ${relTime(d.seenAt)}` : ""}
                  {d.pushToken ? ", notifications on" : ", notifications off"}
                </div>
              </div>
              <Confirm text="Sign this phone out?" onConfirm={() => revoke(d.id)}>
                {(ask) => (
                  <Button size="sm" variant="ghost" busy={busy === `revoke:${d.id}`} onClick={ask}>
                    Sign out
                  </Button>
                )}
              </Confirm>
            </div>
          ))}
        </div>
      )}
      {invite && <InviteModal invite={invite} name={p.name} onClose={() => setInvite(undefined)} />}
    </div>
  )
}

function NewAppPerson({ onClose, reload }: { onClose: () => void; reload: () => Promise<void> }) {
  const { busy, run } = useAction()
  const [name, setName] = useState("")
  const [invite, setInvite] = useState<AppInvite>()
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    void run("create", () => api<AppInvite>("POST", "/api/people/app", { name }).then((i) => (setInvite(i), reload())))
  }
  if (invite) return <InviteModal invite={invite} name={name} onClose={onClose} />
  return (
    <Modal title="Invite someone to the app" subtitle="For people who don't use Telegram. People who do can send /app to the bot instead, so their Telegram conversations come along." onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">
          <input className="input" autoFocus maxLength={60} placeholder="e.g. Sanne" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="row-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy === "create"} disabled={!name.trim()}>
            Create invite
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function InviteModal({ invite, name, onClose }: { invite: AppInvite; name: string | null; onClose: () => void }) {
  const expires = new Date(invite.expiresAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
  return (
    <Modal title={`App invite${name ? ` for ${name}` : ""}`} subtitle={`Scan it with the phone's camera or the app, or send the link. It works once and expires ${expires}.`} onClose={onClose}>
      <div className="stack" style={{ alignItems: "center" }}>
        <div style={{ width: 240, background: "#fff", borderRadius: 12, padding: 8 }} dangerouslySetInnerHTML={{ __html: invite.qr }} />
        <input className="input mono" readOnly value={invite.url} onFocus={(e) => e.currentTarget.select()} />
        <Button onClick={() => void navigator.clipboard.writeText(invite.url)}>Copy link</Button>
      </div>
    </Modal>
  )
}

const amount = (v: number | null) => (v === null ? "" : String(v))
const parseAmount = (v: string) => v.trim().replace(/^\$/, "")

function Spending({ person: p, defaults, reload }: { person: PersonInfo; defaults: PeopleResponse["defaultLimits"]; reload: () => Promise<void> }) {
  const { busy, run } = useAction()
  const [daily, setDaily] = useState(amount(p.spendDaily))
  const [monthly, setMonthly] = useState(amount(p.spendMonthly))
  useEffect(() => setDaily(amount(p.spendDaily)), [p.spendDaily])
  useEffect(() => setMonthly(amount(p.spendMonthly)), [p.spendMonthly])
  const valid = [daily, monthly].every((v) => parseAmount(v) === "" || Number(parseAmount(v)) > 0)
  const dirty = parseAmount(daily) !== amount(p.spendDaily) || parseAmount(monthly) !== amount(p.spendMonthly)
  const save = (body: { spendDaily?: string | null; spendMonthly?: string | null; spendExempt?: boolean }) => run("spend", () => api("PUT", `/api/people/${p.id}`, body).then(reload), "Saved")
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (valid && dirty) void save({ spendDaily: parseAmount(daily) || null, spendMonthly: parseAmount(monthly) || null })
  }
  const fallback = (v: number | null) => (v === null ? "Default: no limit" : `Default: ${money(v)}`)

  return (
    <div className="stack">
      <div className="card-head memory-head">
        <h3>Spending</h3>
        <label className="check small">
          <Toggle checked={p.spendExempt} disabled={!!busy} onChange={(v) => save({ spendExempt: v })} />
          No limits
        </label>
      </div>
      {p.spend ? (
        <div className="spend-meters">
          <Meter label="Today" period={p.spend.day} />
          <Meter label="This month" period={p.spend.month} />
        </div>
      ) : (
        <p className="muted small">Spending couldn't be read right now.</p>
      )}
      {!p.spendExempt && (
        <form className="spend-limit-form" onSubmit={submit}>
          <Field label="Daily limit">
            <div className="env-inline">
              <span className="muted">$</span>
              <input className="input mono" inputMode="decimal" placeholder={fallback(defaults.daily)} value={daily} onChange={(e) => setDaily(e.target.value)} />
            </div>
          </Field>
          <Field label="Monthly limit">
            <div className="env-inline">
              <span className="muted">$</span>
              <input className="input mono" inputMode="decimal" placeholder={fallback(defaults.monthly)} value={monthly} onChange={(e) => setMonthly(e.target.value)} />
            </div>
          </Field>
          <Button type="submit" busy={busy === "spend"} disabled={!valid || !dirty}>
            Save
          </Button>
        </form>
      )}
    </div>
  )
}

function Meter({ label, period: p }: { label: string; period: PeriodSpend }) {
  const share = p.limit ? p.spent / p.limit : 0
  const state = p.limit === null ? "" : share >= 1 ? "reached" : share >= 0.8 ? "near" : ""
  const resets = new Date(p.resetsAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  return (
    <div className={`spend-meter ${state}`}>
      <div className="spend-meter-head">
        <span className="muted small">{label}</span>
        <span className="mono">
          {money(p.spent)}
          {p.limit !== null && <span className="muted"> of {money(p.limit)}</span>}
        </span>
      </div>
      <div className="bar">
        <span style={{ width: `${p.limit ? Math.min(100, Math.max(1, share * 100)) : 0}%` }} />
      </div>
      <span className="muted small">
        {p.limit === null ? "No limit" : state === "reached" ? `Limit reached · resets ${resets}` : `${Math.round(share * 100)}% · resets ${resets}`}
      </span>
    </div>
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
