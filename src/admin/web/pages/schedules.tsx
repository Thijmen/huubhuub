import { useEffect, useMemo, useState } from "react"
import { api, type RunStatus, type ScheduleInfo, type SchedulePreview, type SchedulesResponse, type SettingsResponse } from "../api"
import { Badge, Button, Confirm, Empty, ErrorBanner, Field, Modal, PageHeader, relTime, Skeleton, Toggle, useAction, useApi } from "../ui"

const STATUS_TONE: Record<RunStatus, "ok" | "warn" | "error" | "neutral" | "accent"> = {
  running: "accent",
  ok: "ok",
  silent: "neutral",
  failed: "error",
  skipped: "warn",
  missed: "warn",
}

export function SchedulesPage({ openThread }: { openThread: (sessionID: string) => void }) {
  const { data, error, reload } = useApi<SchedulesResponse>("/api/schedules", 10_000)
  const [editing, setEditing] = useState<ScheduleInfo | "new">()

  const groups = useMemo(() => {
    if (!data) return []
    const title = new Map(data.chats.map((c) => [c.id, c.title]))
    const byChat = new Map<number, ScheduleInfo[]>()
    for (const s of data.schedules) byChat.set(s.chatId, [...(byChat.get(s.chatId) ?? []), s])
    return [...byChat.entries()].map(([chatId, list]) => ({ chatId, title: title.get(chatId) ?? null, list }))
  }, [data])

  return (
    <>
      <PageHeader
        title="Schedules"
        subtitle={
          <>
            Prompts that run on their own, each in a fresh topic. Times are in <span className="mono">{data?.timeZone ?? "…"}</span> (change it in Settings).
          </>
        }
        actions={
          <Button variant="primary" disabled={!data?.chats.length} onClick={() => setEditing("new")}>
            + New schedule
          </Button>
        }
      />
      <ErrorBanner error={error} onRetry={reload} />
      {!data ? (
        <Skeleton rows={3} />
      ) : groups.length === 0 ? (
        <Empty icon="⏰" title="No scheduled prompts yet">
          Create one here, or send <span className="mono">/schedule @daily 08:00 your prompt</span> to the bot.
        </Empty>
      ) : (
        <div className="stack">
          {groups.map((g) => (
            <section key={g.chatId} className="stack">
              <h3 className="schedule-chat">
                {g.title ?? "Chat"} <span className="mono muted small">{g.chatId}</span>
              </h3>
              {g.list.map((s) => (
                <ScheduleCard key={s.id} schedule={s} timeZone={data.timeZone} onChanged={reload} onEdit={() => setEditing(s)} openThread={openThread} />
              ))}
            </section>
          ))}
        </div>
      )}
      {editing && data && (
        <ScheduleEditor
          schedule={editing === "new" ? undefined : editing}
          chats={data.chats}
          timeZone={data.timeZone}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined)
            await reload()
          }}
        />
      )}
    </>
  )
}

function ScheduleCard({
  schedule: s,
  timeZone,
  onChanged,
  onEdit,
  openThread,
}: {
  schedule: ScheduleInfo
  timeZone: string
  onChanged: () => Promise<void>
  onEdit: () => void
  openThread: (sessionID: string) => void
}) {
  const { busy, run } = useAction()
  const [showRuns, setShowRuns] = useState(false)
  const path = `/api/schedules/${s.id}`
  const act = (id: string, fn: () => Promise<unknown>, ok?: string) => run(id, () => fn().then(onChanged), ok)

  return (
    <div className="card schedule-card">
      <div className="schedule-head">
        <div className="schedule-title">
          <strong>{s.name}</strong>
          <span className="muted small">
            {s.description}
            {s.nextAt && !s.paused ? ` · next ${formatAt(s.nextAt, timeZone)}` : ""}
          </span>
        </div>
        <div className="schedule-badges">
          {s.running && (
            <Badge tone="accent" pulse>
              running
            </Badge>
          )}
          {s.paused && <Badge tone="warn">paused</Badge>}
          {!s.paused && s.kind === "once" && !s.nextAt && <Badge>done</Badge>}
          {s.silent && <Badge>🔕 silent</Badge>}
          {s.failStreak > 0 && <Badge tone="error">{s.failStreak} failed</Badge>}
        </div>
      </div>
      <p className="schedule-prompt">{s.prompt}</p>
      <div className="schedule-meta muted small">
        <span className="mono">{s.model ?? "default model"}</span> · <span>{s.agent ?? "default agent"}</span>
      </div>
      <div className="row-end">
        <Button size="sm" variant="ghost" onClick={() => setShowRuns((v) => !v)}>
          {showRuns ? "Hide history" : `History (${s.runs.length})`}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" busy={busy === "pause"} onClick={() => act("pause", () => api("PUT", path, { paused: !s.paused }), s.paused ? "Resumed" : "Paused")}>
          {s.paused ? "▶ Resume" : "⏸ Pause"}
        </Button>
        <Button size="sm" busy={busy === "run"} disabled={s.running} onClick={() => act("run", () => api("POST", `${path}/run`), "Started")}>
          ⚡ Run now
        </Button>
        <Confirm text="Really delete?" onConfirm={() => void act("delete", () => api("DELETE", path), "Deleted")}>
          {(ask) => (
            <Button size="sm" variant="danger" busy={busy === "delete"} onClick={ask}>
              Delete
            </Button>
          )}
        </Confirm>
      </div>
      {showRuns && (
        <table className="table schedule-runs">
          <tbody>
            {s.runs.length === 0 && (
              <tr>
                <td className="muted">No runs yet.</td>
              </tr>
            )}
            {s.runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                </td>
                <td className="small" title={new Date(r.startedAt).toISOString()}>
                  {formatAt(r.startedAt, timeZone)} <span className="muted">({relTime(r.startedAt)})</span>
                </td>
                <td className="small muted">{r.endedAt && r.status !== "missed" && r.status !== "skipped" ? `${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))}s` : ""}</td>
                <td className="small">{r.error}</td>
                <td className="num">
                  {r.sessionID && (
                    <Button size="sm" variant="ghost" onClick={() => openThread(r.sessionID!)}>
                      Open →
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function ScheduleEditor({
  schedule,
  chats,
  timeZone,
  onClose,
  onSaved,
}: {
  schedule?: ScheduleInfo
  chats: SchedulesResponse["chats"]
  timeZone: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { data: settings } = useApi<SettingsResponse>("/api/settings")
  const { busy, run } = useAction()
  const [chatId, setChatId] = useState(schedule?.chatId ?? chats[0]?.id)
  const [name, setName] = useState(schedule?.name ?? "")
  const [when, setWhen] = useState(schedule ? whenText(schedule, timeZone) : "@daily 08:00")
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "")
  const [model, setModel] = useState(schedule?.model ?? "")
  const [agent, setAgent] = useState(schedule?.agent ?? "")
  const [silent, setSilent] = useState(schedule?.silent ?? false)
  const [preview, setPreview] = useState<SchedulePreview>()
  const [previewError, setPreviewError] = useState<string>()

  // A one-off job's stored time can't be re-parsed as "at …" once it's in the past; only preview edits.
  const whenChanged = !schedule || when !== whenText(schedule, timeZone)

  useEffect(() => {
    if (!when.trim()) return
    const t = setTimeout(() => {
      api<SchedulePreview>("POST", "/api/schedules/preview", { when })
        .then((p) => {
          setPreview(p)
          setPreviewError(undefined)
        })
        .catch((err) => {
          setPreview(undefined)
          setPreviewError((err as Error).message)
        })
    }, 300)
    return () => clearTimeout(t)
  }, [when])

  const submit = () =>
    run(
      "save",
      async () => {
        const body = {
          name: name.trim() || undefined,
          prompt,
          model: model || null,
          agent: agent || null,
          silent,
          ...(whenChanged ? { when } : {}),
        }
        if (schedule) await api("PUT", `/api/schedules/${schedule.id}`, body)
        else await api("POST", "/api/schedules", { ...body, chatId })
        await onSaved()
      },
      schedule ? "Saved" : "Scheduled",
    )

  return (
    <Modal title={schedule ? "Edit schedule" : "New schedule"} onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {!schedule && (
          <Field label="Chat">
            <div className="chips">
              {chats.map((c) => (
                <button type="button" key={c.id} className={`chip ${c.id === chatId ? "active" : ""}`} onClick={() => setChatId(c.id)}>
                  <span>{c.title ?? "Chat"}</span>
                  <span className="mono muted small">{c.id}</span>
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label="Name" hint="Defaults to the start of the prompt.">
          <input className="input" maxLength={80} value={name} placeholder="Morning briefing" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="When"
          hint={
            previewError && whenChanged ? (
              <span className="error-text">{previewError}</span>
            ) : preview ? (
              <>
                {preview.description} · next {preview.upcoming.map((t) => formatAt(t, preview.timeZone)).join(", ")}
              </>
            ) : (
              "Cron (0 8 * * 1-5), @hourly, @daily 08:30, every 30m, in 2h, at 2026-10-01 09:00"
            )
          }
        >
          <input className="input mono" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="Prompt">
          <textarea className="input" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <div className="schedule-selects">
          <Field label="Model">
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Default</option>
              {model && !settings?.models.some((m) => m.ref === model) && <option value={model}>{model}</option>}
              {settings?.models.map((m) => (
                <option key={m.ref} value={m.ref}>
                  {m.name} ({m.ref})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agent">
            <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">Default</option>
              {agent && !settings?.agents.some((a) => a.id === agent) && <option value={agent}>{agent}</option>}
              {settings?.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="schedule-silent">
          <Toggle checked={silent} onChange={setSilent} />
          <div>
            <strong>Silent</strong>
            <p className="muted small">The agent may answer [SILENT] when there's nothing to report; then nothing is posted. Otherwise the output is posted all at once when the run ends.</p>
          </div>
        </div>
        <div className="row-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy === "save"} disabled={!prompt.trim() || !when.trim() || (whenChanged && Boolean(previewError))}>
            {schedule ? "Save" : "Schedule"}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** What to show in the "when" box for an existing job. */
function whenText(s: ScheduleInfo, timeZone: string): string {
  if (s.kind === "once") return s.nextAt ? `at ${isoIn(s.nextAt, timeZone)}` : "(already ran)"
  return s.spec
}

/** "2026-10-01 09:00" on the schedule's clock, the format the server parses. */
function isoIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms)
}

function formatAt(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms)
}
