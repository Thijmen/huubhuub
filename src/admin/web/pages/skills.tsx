import { useState } from "react"
import { api, enc, type GitHubAppInfo, type InstalledRepo, type SkillSource } from "../api"
import { Badge, Button, Confirm, Empty, ErrorBanner, Field, Modal, PageHeader, Skeleton, Toggle, relTime, useAction, useApi } from "../ui"

type AppState = { connected: boolean; info: GitHubAppInfo | null }

export function SkillsPage() {
  const { data, error, reload } = useApi<SkillSource[]>("/api/skills", 5000)
  const app = useApi<AppState>("/api/github/app")
  const [dialog, setDialog] = useState<"add" | { edit: SkillSource }>()
  const { busy, run } = useAction()
  const connected = app.data?.connected ?? false

  return (
    <>
      <PageHeader
        title="Skills"
        subtitle="Git repos of SKILL.md skills. They're pulled on startup, on the sync interval in Settings, and when you press Sync. Changes apply live."
        actions={
          <>
            {data && data.length > 0 && (
              <Button busy={busy === "sync-all"} onClick={() => run("sync-all", () => api("POST", "/api/skills/sync").then(reload), "Synced")}>
                ↻ Sync all
              </Button>
            )}
            <Button variant="primary" disabled={!connected} onClick={() => setDialog("add")}>
              + Add repo
            </Button>
          </>
        }
      />
      <ErrorBanner error={error ?? app.error} onRetry={reload} />
      {app.data && !connected && (
        <div className="callout callout-warn gh-skills-hint">
          <span>Skill repos are pulled through the GitHub App. Connect it on the GitHub page first.</span>
          <Button size="sm" onClick={() => (location.hash = "github")}>
            Go to GitHub →
          </Button>
        </div>
      )}
      {!data ? (
        <Skeleton rows={3} />
      ) : data.length === 0 ? (
        <Empty icon="📚" title="No skill repos yet">
          {connected
            ? "Add a repo the GitHub App is installed on. Every SKILL.md in it becomes a skill the agent can load."
            : "Connect the GitHub App first, then add the repos it's installed on."}
        </Empty>
      ) : (
        <div className="mcp-list">
          {data.map((s) => (
            <article key={s.id} className={`mcp card status-${s.lastError ? "failed" : s.checkedOut ? "connected" : "pending"}`}>
              <div className="mcp-head">
                <div className="mcp-title">
                  <span className="mcp-kind">⎇</span>
                  <div>
                    <div className="mcp-name">{s.repo}</div>
                    <div className="mcp-target mono">
                      {s.ref ?? "default branch"}
                      {s.lastCommit && ` · ${s.lastCommit}`}
                    </div>
                  </div>
                </div>
                <div className="mcp-actions">
                  {s.syncing ? (
                    <Badge tone="accent" pulse>
                      syncing
                    </Badge>
                  ) : s.lastError ? (
                    <Badge tone="error">sync failed</Badge>
                  ) : s.lastSyncAt ? (
                    <Badge tone="ok">synced {relTime(s.lastSyncAt)}</Badge>
                  ) : (
                    <Badge>never synced</Badge>
                  )}
                </div>
              </div>
              {s.lastError && (
                <pre className="mcp-error">
                  {s.lastError}
                  {s.checkedOut ? "\nThe skills from the last successful sync stay loaded." : ""}
                </pre>
              )}
              {s.checkedOut && (
                <div className="skill-list">
                  {s.skills.length === 0 && <div className="muted small">No SKILL.md files found in this repo.</div>}
                  {s.skills.map((k) => (
                    <div key={k.id} className={`skill-row ${k.status}`}>
                      <div className="skill-info">
                        <div className="skill-name">
                          <span className="mono">{k.id}</span>
                          {k.path && k.path !== k.id && <span className="muted small mono">{k.path}</span>}
                        </div>
                        {k.error ? <div className="form-error small">{k.error}</div> : k.description && <div className="muted small">{k.description}</div>}
                      </div>
                      {k.status === "error" ? (
                        <Badge tone="error">not loaded</Badge>
                      ) : (
                        <Toggle
                          checked={k.status === "enabled"}
                          disabled={busy === `t-${s.id}/${k.id}`}
                          onChange={(v) =>
                            run(
                              `t-${s.id}/${k.id}`,
                              () => api("PUT", `/api/skills/${enc(s.id)}/skills/${enc(k.id)}/enabled`, { enabled: v }).then(reload),
                              `${k.id} ${v ? "enabled" : "disabled"}`,
                            )
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="mcp-foot">
                <Button size="sm" variant="ghost" busy={busy === `s-${s.id}` || s.syncing} onClick={() => run(`s-${s.id}`, () => api("POST", `/api/skills/${enc(s.id)}/sync`).then(reload))}>
                  ↻ Sync
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDialog({ edit: s })}>
                  Edit
                </Button>
                <Confirm text="Remove repo and its skills?" onConfirm={() => run(`d-${s.id}`, () => api("DELETE", `/api/skills/${enc(s.id)}`).then(reload), `${s.repo} removed`)}>
                  {(ask) => (
                    <Button size="sm" variant="ghost" busy={busy === `d-${s.id}`} onClick={ask}>
                      Remove
                    </Button>
                  )}
                </Confirm>
              </div>
            </article>
          ))}
        </div>
      )}
      {dialog && <SourceDialog source={typeof dialog === "object" ? dialog.edit : undefined} onClose={() => setDialog(undefined)} onDone={reload} />}
    </>
  )
}

function SourceDialog({ source, onClose, onDone }: { source?: SkillSource; onClose: () => void; onDone: () => Promise<void> }) {
  const [repo, setRepo] = useState(source?.repo ?? "")
  const [ref, setRef] = useState(source?.ref ?? "")
  const [defaultBranch, setDefaultBranch] = useState<string>()
  const { busy, run } = useAction()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const saved = source
      ? await run("save", () => api<SkillSource>("PATCH", `/api/skills/${enc(source.id)}`, { ref: ref.trim() || null }))
      : await run("save", () => api<SkillSource>("POST", "/api/skills", { repo, ref: ref.trim() || undefined }))
    if (!saved) return
    await onDone()
    onClose()
  }

  return (
    <Modal title={source ? `Edit ${source.repo}` : "Add skill repo"} subtitle="The bot checks that it can read the repo before saving." onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {source ? (
          <Field label="GitHub repo">
            <input className="input mono" disabled value={source.repo} />
          </Field>
        ) : (
          <RepoPicker
            value={repo}
            onChange={(r) => {
              setRepo(r?.repo ?? "")
              setDefaultBranch(r?.defaultBranch)
            }}
          />
        )}
        <Field label="Branch or tag" hint="Optional. Empty follows the default branch.">
          <input className="input mono" placeholder={defaultBranch ?? "main"} value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <div className="row-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" busy={busy === "save"} disabled={!repo.trim()}>
            {source ? "Save" : "Add repo"}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function RepoPicker({ value, onChange }: { value: string; onChange: (repo: InstalledRepo | undefined) => void }) {
  const { data, error } = useApi<InstalledRepo[]>("/api/github/repos")
  return (
    <Field label="GitHub repo" hint="Repos the GitHub App is installed on. Missing one? Install the app on it, then reopen this dialog.">
      {!data && !error ? (
        <Skeleton rows={1} />
      ) : (
        <select className="input mono" autoFocus value={value} onChange={(e) => onChange(data?.find((r) => r.repo === e.target.value))}>
          <option value="">{data?.length ? "Pick a repo…" : "The app isn't installed on any repos yet"}</option>
          {data?.map((r) => (
            <option key={r.repo} value={r.repo} disabled={r.added}>
              {r.repo}
              {r.private ? " 🔒" : ""}
              {r.added ? " (added)" : ""}
            </option>
          ))}
        </select>
      )}
      {error && <div className="form-error small">{error}</div>}
    </Field>
  )
}
