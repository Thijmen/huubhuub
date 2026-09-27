import { Fragment, useState, type ReactNode } from "react"

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "hr" }
  | { kind: "para"; lines: string[] }

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/
const LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n")
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = line.match(FENCE)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!)
      i++
      out.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      out.push({ kind: "heading", level: h[1]!.length, text: h[2]!.replace(/\s+#+\s*$/, "") })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: "hr" })
      i++
      continue
    }
    if (line.startsWith(">")) {
      const quote: string[] = []
      while (i < lines.length && lines[i]!.startsWith(">")) quote.push(lines[i++]!.replace(/^>\s?/, ""))
      out.push({ kind: "quote", lines: quote })
      continue
    }
    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!))
      out.push({ kind: "table", head, rows })
      continue
    }
    const li = line.match(LIST)
    if (li) {
      const ordered = /\d/.test(li[1]!)
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i]!.match(LIST)
        if (m && /\d/.test(m[1]!) === ordered) items.push(m[2]!)
        else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) items[items.length - 1] += `\n${lines[i]!.trim()}`
        else break
        i++
      }
      out.push({ kind: "list", ordered, start: ordered ? parseInt(li[1]!, 10) : 1, items })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !FENCE.test(lines[i]!) && !/^(#{1,6}\s|>)/.test(lines[i]!) && !(para.length && LIST.test(lines[i]!))) {
      para.push(lines[i++]!)
    }
    out.push({ kind: "para", lines: para })
  }
  return out
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim())
}

const INLINE = /(`+)([\s\S]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)|(?<![\w_])_(?!\s)([^_\n]+?)_(?!\w)/g

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = n++
    if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>)
    else if (m[3] ?? m[4]) out.push(<strong key={k}>{inline(m[3] ?? m[4]!)}</strong>)
    else if (m[5]) out.push(<s key={k}>{inline(m[5])}</s>)
    else if (m[6]) out.push(<a key={k} href={m[7]} target="_blank" rel="noreferrer">{inline(m[6])}</a>)
    else if (m[8]) out.push(<a key={k} href={m[8]} target="_blank" rel="noreferrer">{m[8]}</a>)
    else if (m[9] ?? m[10]) out.push(<em key={k}>{inline(m[9] ?? m[10]!)}</em>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function lines(ls: string[]): ReactNode[] {
  return ls.map((l, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {inline(l)}
    </Fragment>
  ))
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((b, i) => {
        switch (b.kind) {
          case "code":
            return <CodeBlock key={i} lang={b.lang} text={b.text} />
          case "heading": {
            const Tag = `h${Math.min(b.level + 2, 6)}` as "h3"
            return <Tag key={i}>{inline(b.text)}</Tag>
          }
          case "quote":
            return <blockquote key={i}>{lines(b.lines)}</blockquote>
          case "list": {
            const items = b.items.map((it, j) => <li key={j}>{lines(it.split("\n"))}</li>)
            return b.ordered ? <ol key={i} start={b.start}>{items}</ol> : <ul key={i}>{items}</ul>
          }
          case "table":
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>{b.head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>{b.head.map((_, k) => <td key={k}>{inline(r[k] ?? "")}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case "hr":
            return <hr key={i} />
          case "para":
            return <p key={i}>{lines(b.lines)}</p>
        }
      })}
    </div>
  )
}

export function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang || "text"}</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}
