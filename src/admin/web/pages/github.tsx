import { useEffect, useState } from "react"
import { api, type GitHubAppInfo, type GitHubInstallation, type GitHubStatus } from "../api"
import { Badge, Button, Confirm, Empty, ErrorBanner, Field, PageHeader, Skeleton, useAction, useApi } from "../ui"

/** The GitHub redirect is handled once, even if React runs the effect twice. */
let returnHandled = false

export function GitHubPage() {
  const { data, error, reload } = useApi<GitHubStatus>("/api/github")
  const { busy, run } = useAction()

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const step = params.get("github")
    if (!step || returnHandled) return
    returnHandled = true
    history.replaceState(null, "", `${location.pathname}#github`)
    if (step === "created") {
      void run("convert", () => api("POST", "/api/github/app/convert", { code: params.get("code"), state: params.get("state") }).then(reload), "GitHub App created. Now install it on your repos.")
    } else {
      void reload()
    }
  }, [])

  return (
    <>
      <PageHeader
        title="GitHub"
        subtitle="One GitHub App gives the agent gh and git, and lets the bot pull skill repos. The bot mints short-lived tokens on demand; none are stored."
        actions={
          data?.connected && (
            <Button busy={busy === "refresh"} onClick={() => run("refresh", reload)}>
              ↻ Refresh
            </Button>
          )
        }
      />
      <ErrorBanner error={error ?? data?.error ?? undefined} onRetry={reload} />
      {busy === "convert" ? (
        <article className="card gh-app">
          <span className="spinner" /> Finishing the GitHub App setup…
        </article>
      ) : !data ? (
        <Skeleton rows={3} />
      ) : !data.info ? (
        <ConnectCard />
      ) : (
        <div className="stack">
          <AppCard info={data.info} onChange={reload} />
          {data.isPublic === false && <PrivateCallout info={data.info} />}
          {data.missingAppPermissions.length > 0 && <UpgradeCallout info={data.info} missing={data.missingAppPermissions} />}
          <Installations info={data.info} installations={data.installations} onChange={reload} />
          <AgentAccess status={data} />
        </div>
      )}
    </>
  )
}

function ConnectCard() {
  const [name, setName] = useState("")
  const [org, setOrg] = useState("")
  const { busy, run } = useAction()

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    const res = await run("create", () =>
      api<{ action: string; manifest: object }>("POST", "/api/github/app/start", { origin: location.origin, name: name.trim() || undefined, org: org.trim() || undefined }),
    )
    if (!res) return
    // GitHub takes the manifest as a form post and sends the browser back with a code.
    const form = document.createElement("form")
    form.method = "post"
    form.action = res.action
    const input = document.createElement("input")
    input.type = "hidden"
    input.name = "manifest"
    input.value = JSON.stringify(res.manifest)
    form.append(input)
    document.body.append(form)
    form.submit()
  }

  return (
    <article className="card gh-app">
      <div className="gh-app-head">
        <div>
          <div className="mcp-name">Connect GitHub</div>
          <div className="muted small">
            Creates a GitHub App that can read and write code, pull requests and issues, and read Actions and checks, on the repos you pick. You'll confirm it on
            GitHub, then choose where to install it.
          </div>
        </div>
      </div>
      <form className="gh-app-form" onSubmit={create}>
        <Field label="App name" hint="Optional. Must be unique on GitHub.">
          <input className="input mono" placeholder="huub-…" maxLength={34} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Organization" hint="Optional. Empty creates it on your personal account.">
          <input className="input mono" placeholder="my-org" value={org} onChange={(e) => setOrg(e.target.value)} />
        </Field>
        <div className="row-end">
          <Button variant="primary" type="submit" busy={busy === "create"}>
            Create GitHub App ↗
          </Button>
        </div>
      </form>
    </article>
  )
}

function AppCard({ info, onChange }: { info: GitHubAppInfo; onChange: () => Promise<void> }) {
  const { busy, run } = useAction()
  return (
    <article className="card gh-app">
      <div className="gh-app-head">
        <div>
          <div className="mcp-name">
            GitHub App <span className="mono">{info.name}</span>
          </div>
          <div className="muted small">Owned by {info.owner}.</div>
        </div>
        <div className="mcp-actions">
          <a className="btn btn-default btn-sm" href={info.installUrl} target="_blank" rel="noreferrer">
            Install on repos ↗
          </a>
          <a className="btn btn-sm btn-ghost" href={info.settingsUrl} target="_blank" rel="noreferrer">
            App settings ↗
          </a>
          <Confirm
            text="Disconnect? The agent and skill repos lose GitHub access."
            onConfirm={() => run("disconnect", () => api("DELETE", "/api/github/app").then(onChange), "Disconnected. The app still exists on GitHub; delete it from its settings if you like.")}
          >
            {(ask) => (
              <Button size="sm" variant="ghost" busy={busy === "disconnect"} onClick={ask}>
                Disconnect
              </Button>
            )}
          </Confirm>
        </div>
      </div>
    </article>
  )
}

function PrivateCallout({ info }: { info: GitHubAppInfo }) {
  return (
    <div className="callout callout-warn">
      <div>
        <strong>Only {info.owner} can install this app.</strong>
        <p className="muted small gh-callout-text">
          GitHub lets a private app be installed only on the account that owns it, so organizations don't show up when you install it. Choose <em>Make public</em> under
          Advanced in the app's settings, then refresh. Others can then install it too, but that only gives the bot access to their repos, never to yours.
        </p>
      </div>
      <a className="btn btn-default btn-sm" href={`${info.settingsUrl}/advanced`} target="_blank" rel="noreferrer">
        Open Advanced ↗
      </a>
    </div>
  )
}

function UpgradeCallout({ info, missing }: { info: GitHubAppInfo; missing: string[] }) {
  return (
    <div className="callout callout-warn">
      <div>
        <strong>The app can't do everything the agent needs.</strong>
        <p className="muted small gh-callout-text">
          It doesn't ask for {missing.map(permissionLabel).join(", ")}, probably because it was made for read-only skill repos. Set those to <em>Read and write</em> (or{" "}
          <em>Read-only</em>) under Permissions in the app's settings and save. Then each account it's installed on has to accept the change; GitHub emails the owner, or use
          Configure below.
        </p>
      </div>
      <a className="btn btn-default btn-sm" href={`${info.settingsUrl}/permissions`} target="_blank" rel="noreferrer">
        Edit permissions ↗
      </a>
    </div>
  )
}

function Installations({ info, installations, onChange }: { info: GitHubAppInfo; installations: GitHubInstallation[]; onChange: () => Promise<void> }) {
  const { busy, run } = useAction()
  if (installations.length === 0) {
    return (
      <Empty icon="⎇" title="Not installed anywhere yet">
        <a href={info.installUrl} target="_blank" rel="noreferrer">
          Install the app
        </a>{" "}
        on your account or an organization and pick the repos it may use.
      </Empty>
    )
  }
  return (
    <article className="card flush">
      <div className="card-head gh-installs-head">
        <h3>Installed on</h3>
        <span className="muted small">git uses whichever account owns the repo. gh uses the account a command names (like acme/repo), else the checkout's owner, else the default.</span>
      </div>
      <table className="table">
        <tbody>
          {installations.map((i) => (
            <tr key={i.id}>
              <td>
                <strong>{i.account}</strong> <span className="muted small">{i.accountType === "Organization" ? "organization" : "user"}</span>
              </td>
              <td className="small muted">{i.repositorySelection === "all" ? "all repos" : "selected repos"}</td>
              <td>
                {i.suspended ? (
                  <Badge tone="error">suspended</Badge>
                ) : i.missing.length ? (
                  <span title={`Not granted yet: ${i.missing.map(permissionLabel).join(", ")}`}>
                    <Badge tone="warn">needs approval</Badge>
                  </span>
                ) : (
                  <Badge tone="ok">full access</Badge>
                )}
              </td>
              <td>
                {i.isDefault ? (
                  <Badge tone="accent">default</Badge>
                ) : (
                  !i.suspended && (
                    <Button size="sm" variant="ghost" busy={busy === `d-${i.id}`} onClick={() => run(`d-${i.id}`, () => api("PUT", "/api/github/default", { installationId: i.id }).then(onChange), `${i.account} is the default`)}>
                      Make default
                    </Button>
                  )
                )}
              </td>
              <td className="num">
                <a className="btn btn-sm btn-ghost" href={i.htmlUrl} target="_blank" rel="noreferrer">
                  Configure ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  )
}

function AgentAccess({ status }: { status: GitHubStatus }) {
  return (
    <article className="card">
      <h3>What the agent gets</h3>
      <div className="stack gh-agent">
        <div className="kv">
          <span>gh CLI</span>
          {status.gh ? <code>gh {status.gh}</code> : <Badge tone="warn">not installed</Badge>}
        </div>
        <div className="kv">
          <span>Commits as</span>
          <code>{status.identity ? `${status.identity.name} <${status.identity.email}>` : "…"}</code>
        </div>
        <ul className="muted small gh-notes">
          <li>
            Every shell command the agent runs gets a fresh installation token as <span className="mono">GH_TOKEN</span>, so <span className="mono">gh pr create</span>,{" "}
            <span className="mono">gh issue list</span> and <span className="mono">gh api</span> work. A <span className="mono">GH_TOKEN</span> or{" "}
            <span className="mono">GITHUB_TOKEN</span> you set yourself takes precedence.
          </li>
          <li>git over HTTPS to github.com asks the bot for a token for the repo's owner, so clone, fetch and push need no setup. Scheduled commands work the same way.</li>
          <li>
            Tokens act as the app, not as you: commands that need a user, like <span className="mono">gh pr status</span> or <span className="mono">--search @me</span>, don't work.
          </li>
          {!status.gh && <li>Install the GitHub CLI where the bot runs to use gh. The Docker image has it.</li>}
        </ul>
      </div>
    </article>
  )
}

function permissionLabel(p: string): string {
  const [name, level] = p.split(":")
  return `${(name ?? "").replaceAll("_", " ")} (${level})`
}
