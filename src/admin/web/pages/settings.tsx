import { useEffect, useMemo, useState } from "react"
import { api, type SettingInfo, type SettingsResponse } from "../api"
import { Badge, Button, ErrorBanner, PageHeader, Segmented, Skeleton, useAction, useApi } from "../ui"

export function SettingsPage() {
  const { data, error, reload } = useApi<SettingsResponse>("/api/settings")
  const get = (key: SettingInfo["key"]) => data?.settings.find((s) => s.key === key)

  return (
    <>
      <PageHeader title="Settings" subtitle="Runtime settings override the container environment and apply immediately." />
      <ErrorBanner error={error} onRetry={reload} />
      {!data ? (
        <Skeleton rows={4} />
      ) : (
        <div className="settings">
          <ModelSetting setting={get("DEFAULT_MODEL")!} models={data.models} onSaved={reload} />
          <AgentSetting setting={get("DEFAULT_AGENT")!} agents={data.agents} onSaved={reload} />
          <UsersSetting setting={get("ALLOWED_USER_IDS")!} onSaved={reload} />
          <ThreadSetting setting={get("THREAD_MODE")!} onSaved={reload} />
          <StreamingSetting setting={get("TELEGRAM_STREAMING")!} onSaved={reload} />
          <QuestionTimeoutSetting setting={get("QUESTION_TIMEOUT_MINUTES")!} onSaved={reload} />
          <TimeZoneSetting setting={get("SCHEDULE_TIMEZONE")!} onSaved={reload} />
        </div>
      )}
    </>
  )
}

function useSave(key: SettingInfo["key"], onSaved: () => Promise<void>) {
  const { busy, run } = useAction()
  return {
    busy: busy !== undefined,
    save: (value: string | null) =>
      run("save", () => api("PUT", `/api/settings/${key}`, { value }).then(onSaved), value === null ? "Reset to environment" : "Saved"),
  }
}

function SettingCard({ title, description, setting, onReset, busy, children }: { title: string; description: string; setting: SettingInfo; onReset: () => void; busy: boolean; children: React.ReactNode }) {
  return (
    <section className="card setting">
      <div className="setting-head">
        <div>
          <h3>{title}</h3>
          <p className="muted small">{description}</p>
        </div>
        <div className="setting-source">
          <Badge tone={setting.source === "admin" ? "accent" : "neutral"}>{setting.source === "admin" ? "set here" : setting.source === "env" ? "from env" : "default"}</Badge>
          {setting.source === "admin" && (
            <button className="link small" disabled={busy} onClick={onReset}>
              reset{setting.envValue ? ` to ${setting.envValue}` : ""}
            </button>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}

function ModelSetting({ setting, models, onSaved }: { setting: SettingInfo; models: SettingsResponse["models"]; onSaved: () => Promise<void> }) {
  const { busy, save } = useSave("DEFAULT_MODEL", onSaved)
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return models.filter((m) => !q || m.ref.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)).slice(0, 60)
  }, [models, query])
  const current = models.find((m) => m.ref === setting.value)

  return (
    <SettingCard title="Default model" description="Used for new conversations. Anyone can still switch with /model." setting={setting} busy={busy} onReset={() => save(null)}>
      <div className="combo">
        <button className="input combo-trigger" onClick={() => setOpen((o) => !o)}>
          {setting.value ? (
            <>
              <span>{current?.name ?? setting.value}</span>
              <span className="mono muted small">{setting.value}</span>
            </>
          ) : (
            <span className="muted">OpenCode picks automatically</span>
          )}
          <span className="chev">▾</span>
        </button>
        {open && (
          <div className="combo-pop">
            <input autoFocus className="input" placeholder={`Search ${models.length} models…`} value={query} onChange={(e) => setQuery(e.target.value)} />
            <ul>
              {filtered.map((m) => (
                <li key={m.ref}>
                  <button
                    className={m.ref === setting.value ? "active" : ""}
                    onClick={() => {
                      setOpen(false)
                      void save(m.ref)
                    }}
                  >
                    <span>{m.name}</span>
                    <span className="mono muted small">{m.ref}</span>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && <li className="muted small combo-empty">No models match.</li>}
            </ul>
          </div>
        )}
      </div>
    </SettingCard>
  )
}

function AgentSetting({ setting, agents, onSaved }: { setting: SettingInfo; agents: SettingsResponse["agents"]; onSaved: () => Promise<void> }) {
  const { busy, save } = useSave("DEFAULT_AGENT", onSaved)
  return (
    <SettingCard title="Default agent" description="The agent new conversations start with." setting={setting} busy={busy} onReset={() => save(null)}>
      <div className="chips">
        {agents.map((a) => (
          <button key={a.id} className={`chip ${setting.value === a.id ? "active" : ""}`} disabled={busy} title={a.description} onClick={() => save(a.id)}>
            {a.name}
          </button>
        ))}
      </div>
    </SettingCard>
  )
}

function UsersSetting({ setting, onSaved }: { setting: SettingInfo; onSaved: () => Promise<void> }) {
  const { busy, save } = useSave("ALLOWED_USER_IDS", onSaved)
  const ids = setting.value ? setting.value.split(",").filter(Boolean) : []
  const [draft, setDraft] = useState("")

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const next = draft
      .split(/[\s,]+/)
      .map((v) => v.trim())
      .filter((v) => /^\d+$/.test(v))
    if (!next.length) return
    void save([...new Set([...ids, ...next])].join(","))
    setDraft("")
  }

  return (
    <SettingCard
      title="Allowed Telegram users"
      description="Only these user IDs can talk to the bot. Message @userinfobot on Telegram to find yours."
      setting={setting}
      busy={busy}
      onReset={() => save(null)}
    >
      <div className="chips">
        {ids.map((id) => (
          <span key={id} className="chip chip-static mono">
            {id}
            <button aria-label={`Remove ${id}`} disabled={busy} onClick={() => save(ids.filter((x) => x !== id).join(","))}>
              ✕
            </button>
          </span>
        ))}
        {ids.length === 0 && <span className="muted small">Nobody yet. The bot ignores all messages.</span>}
      </div>
      <form className="env-inline" onSubmit={add}>
        <input className="input mono" inputMode="numeric" placeholder="123456789" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button busy={busy} disabled={!draft.trim()} type="submit">
          Add
        </Button>
      </form>
    </SettingCard>
  )
}

function ThreadSetting({ setting, onSaved }: { setting: SettingInfo; onSaved: () => Promise<void> }) {
  const { busy, save } = useSave("THREAD_MODE", onSaved)
  const [value, setValue] = useState(setting.value || "auto")
  useEffect(() => setValue(setting.value || "auto"), [setting.value])
  return (
    <SettingCard
      title="Threads"
      description="In auto mode every new conversation gets its own Telegram topic. Private chats need Threaded Mode enabled in @BotFather; groups need topics turned on."
      setting={setting}
      busy={busy}
      onReset={() => save(null)}
    >
      <Segmented
        value={value as "auto" | "off"}
        onChange={(v) => {
          setValue(v)
          void save(v)
        }}
        options={[
          { value: "auto", label: "New topic per conversation" },
          { value: "off", label: "Single chat" },
        ]}
      />
    </SettingCard>
  )
}

function StreamingSetting({ setting, onSaved }: { setting: SettingInfo; onSaved: () => Promise<void> }) {
  const { busy, save } = useSave("TELEGRAM_STREAMING", onSaved)
  const [value, setValue] = useState(setting.value || "draft")
  useEffect(() => setValue(setting.value || "draft"), [setting.value])
  return (
    <SettingCard
      title="Streaming"
      description="Live drafts stream the answer as it is written, with a stop button, and send the final message when done. Only private chats support drafts; groups always update one message in place."
      setting={setting}
      busy={busy}
      onReset={() => save(null)}
    >
      <Segmented
        value={value as "draft" | "edit"}
        onChange={(v) => {
          setValue(v)
          void save(v)
        }}
        options={[
          { value: "draft", label: "Live draft" },
          { value: "edit", label: "Edit message" },
        ]}
      />
    </SettingCard>
  )
}

function QuestionTimeoutSetting({ setting, onSaved }: { setting: SettingInfo; onSaved: () => Promise<void> }) {
  const { busy, save } = useSave("QUESTION_TIMEOUT_MINUTES", onSaved)
  const [draft, setDraft] = useState(setting.value)
  useEffect(() => setDraft(setting.value), [setting.value])
  const valid = /^[1-9]\d*$/.test(draft.trim())
  return (
    <SettingCard
      title="Question timeout"
      description="How long the agent waits for an answer to one of its questions. After that the question is dismissed and the agent carries on."
      setting={setting}
      busy={busy}
      onReset={() => save(null)}
    >
      <form
        className="env-inline"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) void save(draft.trim())
        }}
      >
        <input className="input mono" inputMode="numeric" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <span className="muted small">minutes</span>
        <Button busy={busy} disabled={!valid || draft.trim() === setting.value} type="submit">
          Save
        </Button>
      </form>
    </SettingCard>
  )
}

const TIME_ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []

function TimeZoneSetting({ setting, onSaved }: { setting: SettingInfo; onSaved: () => Promise<void> }) {
  const { busy, save } = useSave("SCHEDULE_TIMEZONE", onSaved)
  const [draft, setDraft] = useState(setting.value)
  useEffect(() => setDraft(setting.value), [setting.value])
  return (
    <SettingCard
      title="Schedule time zone"
      description="Scheduled prompts run on this clock, including daylight saving changes. Defaults to the server's time zone."
      setting={setting}
      busy={busy}
      onReset={() => save(null)}
    >
      <form
        className="env-inline"
        onSubmit={(e) => {
          e.preventDefault()
          if (draft.trim()) void save(draft.trim())
        }}
      >
        <input className="input mono" list="time-zones" placeholder="Europe/Amsterdam" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <datalist id="time-zones">
          {TIME_ZONES.map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
        <Button busy={busy} disabled={!draft.trim() || draft.trim() === setting.value} type="submit">
          Save
        </Button>
      </form>
    </SettingCard>
  )
}
