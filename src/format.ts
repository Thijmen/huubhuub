export const TELEGRAM_LIMIT = 4096

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function inline(s: string): string {
  const codes: string[] = []
  let out = s.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = escapeHtml(out)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
  out = out.replace(/__([^_\n]+)__/g, "<b>$1</b>")
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>")
  out = out.replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)] ?? "")
}

/** Convert a subset of Markdown to Telegram-safe HTML. */
export function markdownToHtml(md: string): string {
  const parts: string[] = []
  const fence = /```([\w+-]*)\n?([\s\S]*?)(```|$)/g
  let last = 0
  for (const m of md.matchAll(fence)) {
    parts.push(renderBlocks(md.slice(last, m.index)))
    const lang = m[1] ? ` class="language-${m[1]}"` : ""
    parts.push(`<pre><code${lang}>${escapeHtml((m[2] ?? "").replace(/\n$/, ""))}</code></pre>`)
    last = (m.index ?? 0) + m[0].length
  }
  parts.push(renderBlocks(md.slice(last)))
  return parts.join("")
}

function renderBlocks(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const h = line.match(/^#{1,6}\s+(.*)$/)
      if (h) return `<b>${inline(h[1] ?? "")}</b>`
      const li = line.match(/^(\s*)[-*+]\s+(.*)$/)
      if (li) return `${li[1]}• ${inline(li[2] ?? "")}`
      const q = line.match(/^>\s?(.*)$/)
      if (q) return `<blockquote>${inline(q[1] ?? "")}</blockquote>`
      return inline(line)
    })
    .join("\n")
}

/** Split plain text into chunks under the limit, preferring newline boundaries. */
export function chunkText(text: string, limit = TELEGRAM_LIMIT - 96): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit)
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit)
    if (cut < limit / 2) cut = limit
    let head = rest.slice(0, cut)
    // Keep fenced code blocks balanced across chunks.
    const fences = (head.match(/```/g) ?? []).length
    rest = rest.slice(cut).replace(/^\n/, "")
    if (fences % 2 === 1) {
      head += "\n```"
      rest = "```\n" + rest
    }
    chunks.push(head)
  }
  if (rest.length) chunks.push(rest)
  return chunks
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…"
}

export function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = input?.[k]
      if (typeof v === "string" && v) return v
    }
    return ""
  }
  const detail = pick("command", "filePath", "path", "pattern", "url", "query", "description", "agent")
  return detail ? `${name}: ${truncate(detail.replace(/\s+/g, " "), 80)}` : name
}
