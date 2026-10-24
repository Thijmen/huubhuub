import { useState } from "react"
import { api, type MemoryMode, type PersonaInfo, type PersonasResponse } from "../api"
import { Badge, Button, Confirm, Empty, ErrorBanner, Field, Modal, PageHeader, relTime, Segmented, Skeleton, useAction, useApi } from "../ui"

export const MEMORY_MODE_OPTIONS: { value: MemoryMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Nothing is remembered between conversations." },
  { value: "explicit", label: "When asked", hint: "Only saves something when the user says \"remember…\"." },
  { value: "auto", label: "Automatic", hint: "Also saves the occasional lasting fact on its own (high bar), and says so in the reply." },
]

export function PersonasPage() {
  const { data, error, reload } = useApi<PersonasResponse>("/api/personas")
  const { busy, run } = useAction()
  const [editing, setEditing] = useState<PersonaInfo | "new">()

  const setDefaults = (body: { personaId?: number | null; memoryMode?: MemoryMode | null }) =>
    run("defaults", () => api("PUT", "/api/personas/defaults", body).then(reload), "Saved")

  return (
    <>
      <PageHeader
        title="Personas"
        subtitle="Who the bot is: name, character, tone and house rules, added to the system prompt. Everyone gets the default unless they pick another with /persona or you set one on the People page."
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            New persona
          </Button>
        }
      />
      <ErrorBanner error={error} onRetry={reload} />
      {!data ? (
        <Skeleton rows={3} />
      ) : (
        <>
          <section className="card setting">
            <div className="setting-head">
              <div>
                <h3>Defaults</h3>
                <p className="muted small">For people who haven't picked their own. Changes apply from the next message.</p>
              </div>
            </div>
            <div className="stack">
              <Field label="Default persona">
                <div className="chips">
                  {data.personas.map((p) => (
                    <button key={p.id} className={`chip ${data.defaultPersonaId === p.id ? "active" : ""}`} disabled={!!busy} onClick={() => setDefaults({ personaId: p.id })}>
                      {p.name}
                    </button>
                  ))}
                  <button className={`chip ${data.defaultPersonaId === null ? "active" : ""}`} disabled={!!busy} onClick={() => setDefaults({ personaId: null })}>
                    None (OpenCode's own)
                  </button>
                </div>
              </Field>
              <Field label="Default memory" hint={MEMORY_MODE_OPTIONS.find((o) => o.value === data.defaultMemoryMode)?.hint}>
                <Segmented value={data.defaultMemoryMode} onChange={(v) => setDefaults({ memoryMode: v })} options={MEMORY_MODE_OPTIONS} />
              </Field>
            </div>
          </section>

          {data.personas.length === 0 ? (
            <Empty icon="🎭" title="No personas yet">
              Without one the bot is OpenCode's default assistant.
            </Empty>
          ) : (
            <div className="mcp-list">
              {data.personas.map((p) => (
                <article key={p.id} className="card schedule-card">
                  <div className="schedule-head">
                    <div className="persona-title">
                      <strong>{p.name}</strong>
                      {data.defaultPersonaId === p.id && <Badge tone="accent">default</Badge>}
                      {p.users > 0 && <Badge>{p.users === 1 ? "1 person" : `${p.users} people`}</Badge>}
                      <span className="muted small">edited {relTime(p.updatedAt)}</span>
                    </div>
                    <div className="row">
                      <Button size="sm" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                      <Confirm text="Delete?" onConfirm={() => run(`rm-${p.id}`, () => api("DELETE", `/api/personas/${p.id}`).then(reload), `${p.name} deleted`)}>
                        {(ask) => (
                          <Button size="sm" variant="ghost" busy={busy === `rm-${p.id}`} onClick={ask}>
                            Delete
                          </Button>
                        )}
                      </Confirm>
                    </div>
                  </div>
                  <pre className="schedule-prompt muted small">{p.prompt}</pre>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {editing && <PersonaEditor persona={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={reload} />}
    </>
  )
}

function PersonaEditor({ persona, onClose, onSaved }: { persona?: PersonaInfo; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(persona?.name ?? "")
  const [prompt, setPrompt] = useState(persona?.prompt ?? "")
  const { busy, run } = useAction()
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const ok = await run(
      "save",
      () => (persona ? api("PUT", `/api/personas/${persona.id}`, { name, prompt }) : api("POST", "/api/personas", { name, prompt })).then(() => true),
      persona ? "Persona saved" : "Persona created",
    )
    if (!ok) return
    await onSaved()
    onClose()
  }
  return (
    <Modal wide title={persona ? `Edit ${persona.name}` : "New persona"} subtitle="Write it as instructions to the assistant. The bot adds the date, who it's talking to, Telegram formatting and memory rules itself." onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Name">
          <input className="input" autoFocus={!persona} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Huub" />
        </Field>
        <Field label="Instructions" hint={`${prompt.length.toLocaleString()} characters`}>
          <textarea className="input mono" rows={22} spellCheck={false} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={"You are Huub, a friendly assistant…\n\n## Tone\n- …"} />
        </Field>
        <div className="row-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy === "save"} disabled={!name.trim() || !prompt.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  )
}
