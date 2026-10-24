import type { Context } from "grammy"
import type { MessageEntity } from "grammy/types"

/**
 * Telegram sends formatting next to the text, not in it: a link written as "Unsplash" keeps its address only
 * in an entity, so the plain text loses it. This rebuilds what carries meaning for the agent as Markdown:
 * links, mentions of people without a username, inline code and code blocks. Bold, italics and the like stay
 * plain text. Offsets are in UTF-16 code units, like JavaScript strings.
 */
export function withEntities(text: string, entities: readonly MessageEntity[] | undefined): string {
  // None of these can contain another one, so they never nest.
  const kept = (entities ?? []).filter((e) => e.type === "text_link" || e.type === "text_mention" || e.type === "code" || e.type === "pre").toSorted((a, b) => a.offset - b.offset)
  let out = ""
  let at = 0
  for (const e of kept) {
    if (e.offset < at) continue
    out += text.slice(at, e.offset)
    const inner = text.slice(e.offset, e.offset + e.length)
    if (e.type === "pre") {
      const before = out && !out.endsWith("\n") ? "\n" : ""
      const next = text.slice(e.offset + e.length)
      const after = next && !next.startsWith("\n") ? "\n" : ""
      const fence = "`".repeat(Math.max(3, longestRun(inner, "`") + 1))
      out += `${before}${fence}${e.language ?? ""}\n${inner}${inner.endsWith("\n") ? "" : "\n"}${fence}${after}`
    } else if (e.type === "code") {
      const fence = "`".repeat(longestRun(inner, "`") + 1)
      const pad = inner.startsWith("`") || inner.endsWith("`") ? " " : ""
      out += `${fence}${pad}${inner}${pad}${fence}`
    } else if (e.type === "text_link") {
      out += link(inner, e.url)
    } else if (e.type === "text_mention") {
      out += link(inner, `tg://user?id=${e.user.id}`)
    }
    at = e.offset + e.length
  }
  return out + text.slice(at)
}

/** The message's text or caption with its links and code kept, as Markdown. */
export function messageText(ctx: Context): string {
  const m = ctx.message
  if (!m) return ""
  if (m.text !== undefined) return withEntities(m.text, m.entities)
  return m.caption !== undefined ? withEntities(m.caption, m.caption_entities) : ""
}

/** What follows a command, like ctx.match, but with links and code kept. */
export function commandArgs(ctx: Context): string {
  const m = ctx.message
  if (!m?.text) return typeof ctx.match === "string" ? ctx.match.trim() : ""
  return withEntities(m.text, m.entities)
    .replace(/^\/\S+\s*/, "")
    .trim()
}

/** `[text](url)`, with whitespace kept outside the brackets so the link text stays tight. */
function link(inner: string, url: string): string {
  const [, lead = "", body = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner) ?? []
  if (!body) return inner
  const label = body.replace(/[\\[\]]/g, (c) => `\\${c}`)
  const target = url.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
  return `${lead}[${label}](${target})${trail}`
}

function longestRun(s: string, ch: string): number {
  let best = 0
  let run = 0
  for (const c of s) {
    run = c === ch ? run + 1 : 0
    best = Math.max(best, run)
  }
  return best
}
