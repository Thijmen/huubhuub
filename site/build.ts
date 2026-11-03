/**
 * Builds the GitHub Pages site into _site/.
 *
 * The landing page (site/index.html) is hand-written. The docs are generated from the repo itself, so they never
 * drift from it: one page per "##" section of README.md, a configuration reference from .env.example, and the
 * changelog from CHANGELOG.md.
 *
 *   bun site/build.ts           build into _site/
 *   bun site/build.ts --serve   build, then serve on http://localhost:4000
 */
import { cp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const OUT = join(ROOT, "_site")
const REPO = "https://github.com/Thijmen/huubhuub"

type Page = {
  slug: string
  title: string
  group: string
  html: string
  /** File to link for "Edit this page", if any. */
  source?: string
}

/** Sidebar order. README sections that aren't listed here end up under "Reference". */
const GROUPS: [string, string[]][] = [
  ["Getting started", ["introduction", "setup", "architecture", "configuration"]],
  ["Using Huub", ["threads", "questions", "scheduled-tasks", "personas-and-memory", "costs-and-spending-limits"]],
  ["Integrations", ["github", "skills"]],
  ["Apps", ["phone-app", "admin-ui"]],
  ["Reference", ["notes", "changelog"]],
]

/** Screenshots shown after a page's first paragraph. */
const FIGURES: Record<string, string> = {
  introduction: figure("admin-conversation.png", "A conversation in the admin UI: the streamed reply, tool calls, and the tokens and cost of each turn."),
  "phone-app": phones(["phone-list-light.png", "phone-chat-light.png", "phone-question-light.png"], "The app's conversation list, a chat while Huub works, and an agent question."),
  "admin-ui": figure("admin-overview.png", "The admin UI's overview page."),
  "costs-and-spending-limits": figure("admin-costs.png", "The Costs page: spend over time by model, by source and by person."),
  "personas-and-memory": figure("admin-people.png", "The People page: a person's persona, memory mode, memories and spending limits."),
  "scheduled-tasks": figure("admin-schedules.png", "The Schedules page, with each job's run history."),
}

const pkg = await Bun.file(join(ROOT, "package.json")).json()
const version: string = pkg.version

// ---------- markdown → pages ----------

function render(md: string): string {
  return Bun.markdown.html(md, { headings: { ids: true }, autolinks: true })
}

/** Split markdown on "## " headings, ignoring anything inside code fences. */
function sections(md: string): { title: string | null; body: string }[] {
  const out: { title: string | null; body: string[] }[] = [{ title: null, body: [] }]
  let fence = false
  for (const line of md.split("\n")) {
    if (/^(```|~~~)/.test(line)) fence = !fence
    if (!fence && line.startsWith("## ")) out.push({ title: line.slice(3).trim(), body: [] })
    else out.at(-1)!.body.push(line)
  }
  return out.map((s) => ({ title: s.title, body: s.body.join("\n").trim() }))
}

/** "### " becomes "## " so each page's subsections are its h2s. */
function promote(md: string): string {
  let fence = false
  return md
    .split("\n")
    .map((line) => {
      if (/^(```|~~~)/.test(line)) fence = !fence
      return !fence && /^#{3,6} /.test(line) ? line.slice(1) : line
    })
    .join("\n")
}

/** The same slug GitHub gives a heading, so README anchors keep working. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-")
}

const readme = await Bun.file(join(ROOT, "README.md")).text()
const [intro, ...rest] = sections(readme)
const pages: Page[] = [
  {
    slug: "introduction",
    title: "Introduction",
    group: "",
    html: render(intro!.body.replace(/^# .*\n/, "")),
    source: "README.md",
  },
  ...rest.map((s) => ({ slug: slugify(s.title!), title: s.title!, group: "", html: render(promote(s.body)), source: "README.md" })),
  { slug: "configuration", title: "Configuration", group: "", html: envReference(await Bun.file(join(ROOT, ".env.example")).text()), source: ".env.example" },
  { slug: "changelog", title: "Changelog", group: "", html: render(promote((await Bun.file(join(ROOT, "CHANGELOG.md")).text()).replace(/^# .*\n/, ""))) },
]

// Put pages in sidebar order and give each its group.
const known = new Set(GROUPS.flatMap(([, slugs]) => slugs))
const extra = pages.filter((p) => !known.has(p.slug)).map((p) => p.slug)
GROUPS.find(([g]) => g === "Reference")![1].splice(-1, 0, ...extra)
const ordered: Page[] = []
for (const [group, slugs] of GROUPS) {
  for (const slug of slugs) {
    const page = pages.find((p) => p.slug === slug)
    if (page) ordered.push({ ...page, group })
  }
}

// Where every heading id lives, so "#github" or "#who-pays" in README links to the right page.
const anchors = new Map<string, string>()
for (const p of ordered) {
  for (const [, id] of p.html.matchAll(/<h[1-6] id="([^"]+)"/g)) if (!anchors.has(id!)) anchors.set(id!, p.slug)
}
for (const p of ordered) anchors.set(p.slug, p.slug)

/** Path from one docs page to another (or to the site root with to = null). */
function link(from: string, to: string | null): string {
  const up = from === "introduction" ? "../" : "../../"
  if (to === null) return up
  return to === "introduction" ? `${up}docs/` : `${up}docs/${to}/`
}

function postProcess(page: Page): { html: string; toc: { id: string; text: string }[] } {
  let html = page.html
  // Links within the README → the page that has that heading. Repo paths → GitHub.
  html = html.replace(/href="([^"]*)"/g, (whole, href: string) => {
    if (href.startsWith("#")) {
      const id = href.slice(1)
      const target = anchors.get(id)
      if (!target) return whole
      if (target === page.slug) return `href="#${id}"`
      return `href="${link(page.slug, target)}${target === id ? "" : `#${id}`}"`
    }
    if (/^(https?:|mailto:|\/\/)/.test(href)) return whole
    return `href="${REPO}/${href.endsWith("/") ? "tree" : "blob"}/main/${href.replace(/^\.?\//, "")}"`
  })
  // Anchor links on headings, and the table of contents.
  const toc: { id: string; text: string }[] = []
  html = html.replace(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g, (_, id: string, inner: string) => {
    toc.push({ id, text: inner.replace(/<[^>]+>/g, "") })
    return `<h2 id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h2>`
  })
  html = html.replace(/<h3 id="([^"]+)">/g, (_, id: string) => `<h3 id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>`)
  // Screenshots after the first paragraph.
  const fig = FIGURES[page.slug]
  if (fig) {
    const assets = link(page.slug, null) + "assets/screens/"
    const filled = fig.replaceAll("{{screens}}", assets)
    const cut = html.indexOf("</p>")
    html = cut >= 0 ? html.slice(0, cut + 4) + filled + html.slice(cut + 4) : filled + html
  }
  return { html, toc }
}

function figure(file: string, caption: string): string {
  return `<figure class="figure"><img loading="lazy" src="{{screens}}${file}" alt="${escape(caption)}" /><figcaption>${caption}</figcaption></figure>`
}

function phones(files: string[], caption: string): string {
  const imgs = files.map((f) => `<img loading="lazy" src="{{screens}}${f}" alt="" style="width:200px" />`).join("")
  return `<figure class="figure phone"><div class="figure phones" style="margin:0">${imgs}</div><figcaption>${caption}</figcaption></figure>`
}

// ---------- .env.example → configuration reference ----------

function envReference(text: string): string {
  const groups: { name: string; vars: { name: string; value: string; doc: string[]; commented: boolean }[] }[] = []
  let doc: string[] = []
  const group = (name: string) => groups.push({ name, vars: [] })
  group("General")
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    const heading = line.match(/^#\s*---\s*(.+?)\s*---$/)
    const variable = line.match(/^(#\s*)?([A-Z][A-Z0-9_]+)=(.*)$/)
    if (!line) doc = []
    else if (heading) {
      group(heading[1]!)
      doc = []
    } else if (variable) {
      groups.at(-1)!.vars.push({ name: variable[2]!, value: variable[3]!, doc, commented: Boolean(variable[1]) })
      doc = []
    } else if (line.startsWith("#")) doc.push(line.replace(/^#\s?/, ""))
  }
  const inline = (s: string) => escape(s).replace(/`([^`]+)`/g, "<code>$1</code>")
  const body = groups
    .filter((g) => g.vars.length)
    .map((g) => {
      const vars = g.vars
        .map(
          (v) =>
            `<div class="env-var" id="${v.name.toLowerCase()}"><code class="name">${v.name}</code>${
              v.value ? `<span class="def">${v.commented ? "example" : "default"}: <code>${escape(v.value)}</code></span>` : ""
            }${v.doc.length ? `<p>${inline(v.doc.join(" "))}</p>` : ""}</div>`,
        )
        .join("\n")
      return `<h2 id="${slugify(g.name)}">${escape(g.name)}</h2>\n${vars}`
    })
    .join("\n")
  return `<p>Everything is configured with environment variables, read from <code>.env</code> (Docker Compose passes it to the container). Only <code>TELEGRAM_BOT_TOKEN</code> is required. Most settings can also be changed in the admin UI's <strong>Settings</strong> page, which overrides the environment, and provider keys can be pasted on the <strong>Providers</strong> page instead.</p>\n<p>This list is generated from <a href="${REPO}/blob/main/.env.example"><code>.env.example</code></a>.</p>\n${body}`
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// ---------- templates ----------

const GITHUB_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`

function docsPage(page: Page, index: number): string {
  const { html, toc } = postProcess(page)
  const up = link(page.slug, null)
  const prev = ordered[index - 1]
  const next = ordered[index + 1]
  let lastGroup = ""
  const sidebar = ordered
    .map((p) => {
      const head = p.group !== lastGroup ? `<h4>${p.group}</h4>` : ""
      lastGroup = p.group
      return `${head}<a href="${link(page.slug, p.slug)}"${p.slug === page.slug ? ' aria-current="page"' : ""}>${escape(p.title)}</a>`
    })
    .join("\n")
  const tocHtml = toc.length > 1 ? `<b>On this page</b>${toc.map((t) => `<a href="#${t.id}">${escape(t.text)}</a>`).join("")}` : ""
  const title = page.slug === "introduction" ? "HuubHuub docs" : `${page.title} · HuubHuub docs`
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(title)}</title>
    <meta name="description" content="HuubHuub documentation: ${escape(page.title)}." />
    <meta name="theme-color" content="#FFF8F0" />
    <link rel="icon" href="${up}assets/icon.svg" type="image/svg+xml" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="${up}assets/style.css" />
  </head>
  <body class="docs-body">
    <header class="topbar">
      <div class="wrap">
        <a class="brand" href="${up}"><img src="${up}assets/huub.svg" alt="" /><span>Huub<b>Huub</b></span></a>
        <button class="menu-btn" data-toggle=".nav" aria-label="Menu" aria-expanded="false">☰</button>
        <nav class="nav">
          <a href="${up}">Home</a>
          <a href="${up}#tour">Tour</a>
          <a href="${link(page.slug, "introduction")}">Docs</a>
          <a href="${link(page.slug, "changelog")}">Changelog</a>
          <a class="gh" href="${REPO}">${GITHUB_ICON}GitHub</a>
        </nav>
      </div>
    </header>
    <div class="docs">
      <aside>
        <button class="docs-menu" data-toggle=".sidebar" aria-expanded="false">☰ All pages</button>
        <nav class="sidebar">${sidebar}</nav>
      </aside>
      <main class="prose">
        <div class="crumb">${escape(page.group)}</div>
        <h1>${escape(page.title)}</h1>
        ${html}
        ${page.source ? `<p class="edit">Generated from <a href="${REPO}/blob/main/${page.source}">${page.source}</a>. <a href="${REPO}/edit/main/${page.source}">Suggest an edit</a></p>` : ""}
        <nav class="pager">
          ${prev ? `<a class="prev" href="${link(page.slug, prev.slug)}"><small>← Previous</small>${escape(prev.title)}</a>` : ""}
          ${next ? `<a class="next" href="${link(page.slug, next.slug)}"><small>Next →</small>${escape(next.title)}</a>` : ""}
        </nav>
      </main>
      <nav class="toc">${tocHtml}</nav>
    </div>
    <script src="${up}assets/site.js" defer></script>
  </body>
</html>
`
}

// ---------- write ----------

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
await cp(join(import.meta.dir, "assets"), join(OUT, "assets"), { recursive: true })
await Bun.write(join(OUT, ".nojekyll"), "")
await Bun.write(join(OUT, "index.html"), (await Bun.file(join(import.meta.dir, "index.html")).text()).replaceAll("{{version}}", version))
for (const [i, page] of ordered.entries()) {
  const dir = page.slug === "introduction" ? join(OUT, "docs") : join(OUT, "docs", page.slug)
  await Bun.write(join(dir, "index.html"), docsPage(page, i))
}
console.log(`Built ${ordered.length} docs pages and the landing page into _site/ (v${version})`)

if (process.argv.includes("--serve")) {
  const server = Bun.serve({
    port: 4000,
    async fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname)
      if (path.endsWith("/")) path += "index.html"
      const file = Bun.file(join(OUT, path))
      if (await file.exists()) return new Response(file)
      return new Response("Not found", { status: 404 })
    },
  })
  console.log(`Serving on ${server.url}`)
}
