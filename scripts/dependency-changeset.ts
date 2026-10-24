// Adds a changeset to a Renovate pull request, so dependency updates get released like any other
// change (AGENTS.md). Run by .github/workflows/dependency-changesets.yml.
//
// An update that ends up in the Docker image gets a patch bump of huubhuub:
//
//   - `dependencies` in package.json changed (the image installs only production dependencies);
//   - bun.lock changed without package.json (lock file maintenance; it may touch anything);
//   - the Dockerfile changed (base image);
//   - anything else outside the list below.
//
// Updates that don't ship (devDependencies such as types and tooling, GitHub Actions, Renovate's
// config, docker-compose.yml for local runs) get an empty changeset, so the PR still has one but
// nothing is released for it.
//
// It only talks to the GitHub API and never runs code from the pull request.
//
//   PR_NUMBER=32 GITHUB_REPOSITORY=owner/repo GH_TOKEN=... bun scripts/dependency-changeset.ts
//
// With DRY_RUN=1 it prints the changeset instead of committing it.

export const PACKAGE = "huubhuub"

/** Files whose updates never reach the image. */
const NOT_SHIPPED = [/^\.github\//, /^renovate\.json5?$/, /^docker-compose\.ya?ml$/]

export const changesetPath = (pr: number) => `.changeset/renovate-${pr}.md`

/** The package.json fields the image installs. */
const SHIPPED_FIELDS = ["dependencies", "optionalDependencies"] as const

/** Whether the production dependencies differ between two versions of package.json (null: missing). */
export function productionDepsChanged(base: string | null, head: string | null): boolean {
  const pick = (text: string | null) => {
    const pkg = text === null ? {} : (JSON.parse(text) as Record<string, unknown>)
    return JSON.stringify(SHIPPED_FIELDS.map((f) => sortKeys(pkg[f])))
  }
  return pick(base) !== pick(head)
}

function sortKeys(value: unknown): unknown {
  if (!value || typeof value !== "object") return value ?? null
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
}

/** Whether a change to `files` ships in the image. `packageJson` is only read when package.json changed. */
export function ships(files: string[], packageJson: { base: string | null; head: string | null }): boolean {
  return files.some((f) => {
    if (f === "package.json") return productionDepsChanged(packageJson.base, packageJson.head)
    if (f === "bun.lock") return !files.includes("package.json")
    return !NOT_SHIPPED.some((re) => re.test(f))
  })
}

export function changesetContent(shipped: boolean, title: string): string {
  return `---\n${shipped ? `"${PACKAGE}": patch\n` : ""}---\n\n${title}\n`
}

// --- GitHub API -------------------------------------------------------------------------------

const repo = process.env.GITHUB_REPOSITORY
const token = process.env.GH_TOKEN

function api(path: string, init: RequestInit = {}, accept = "application/vnd.github+json") {
  return fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  })
}

async function json<T>(path: string): Promise<T> {
  const res = await api(path)
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/** A file's contents at `ref`, or null when it does not exist there. */
async function fileAt(path: string, ref: string): Promise<string | null> {
  const res = await api(`/contents/${path}?ref=${encodeURIComponent(ref)}`, {}, "application/vnd.github.raw+json")
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${path}@${ref}: ${res.status} ${await res.text()}`)
  return res.text()
}

interface PullRequest {
  number: number
  state: string
  title: string
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { sha: string }
}

async function main() {
  const number = Number(process.env.PR_NUMBER)
  if (!repo || !token || !Number.isInteger(number)) throw new Error("Needs PR_NUMBER, GITHUB_REPOSITORY and GH_TOKEN")
  const pr = await json<PullRequest>(`/pulls/${number}`)
  if (pr.state !== "open" || pr.head.repo?.full_name !== repo) {
    console.log("Not an open pull request from this repository; nothing to do.")
    return
  }

  const files: string[] = []
  for (let page = 1; ; page++) {
    const batch = await json<{ filename: string }[]>(`/pulls/${number}/files?per_page=100&page=${page}`)
    files.push(...batch.map((f) => f.filename))
    if (batch.length < 100) break
  }

  const path = changesetPath(number)
  const others = files.filter((f) => /^\.changeset\/.*\.md$/.test(f) && f !== path)
  if (others.length > 0) {
    console.log(`The pull request already has a changeset (${others.join(", ")}); leaving it alone.`)
    return
  }
  const changed = files.filter((f) => f !== path)

  const packageJson = changed.includes("package.json")
    ? { base: await fileAt("package.json", pr.base.sha), head: await fileAt("package.json", pr.head.sha) }
    : { base: null, head: null }
  const shipped = ships(changed, packageJson)
  const content = changesetContent(shipped, pr.title)
  console.log(shipped ? `Ships in the image: patch bump of ${PACKAGE}` : "Doesn't ship in the image: empty changeset")
  if (process.env.DRY_RUN) {
    console.log(`${path}:\n${content}`)
    return
  }

  const existing = await api(`/contents/${path}?ref=${encodeURIComponent(pr.head.ref)}`)
  let sha: string | undefined
  if (existing.ok) {
    const file = (await existing.json()) as { sha: string; content: string }
    if (Buffer.from(file.content, "base64").toString("utf8") === content) {
      console.log(`${path} is up to date.`)
      return
    }
    sha = file.sha
  } else if (existing.status !== 404) {
    throw new Error(`GET ${path}: ${existing.status} ${await existing.text()}`)
  }

  // Renovate ignores commits by this author (gitIgnoredAuthors in renovate.json), so it keeps
  // rebasing the branch; when it does, this workflow runs again and re-adds the changeset.
  const bot = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" }
  const res = await api(`/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: "Add changeset for dependency update",
      content: Buffer.from(content).toString("base64"),
      branch: pr.head.ref,
      sha,
      author: bot,
      committer: bot,
    }),
  })
  if (!res.ok) throw new Error(`PUT ${path}: ${res.status} ${await res.text()}`)
  console.log(`Wrote ${path} to ${pr.head.ref}.`)
}

if (import.meta.main) await main()
