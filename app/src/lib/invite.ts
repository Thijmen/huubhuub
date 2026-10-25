export interface Invite {
  /** The app API's base URL, without a trailing slash. */
  server: string
  code: string
}

/**
 * Read an invite from what was scanned or pasted:
 * - the invite page link, `https://host[/prefix]/pair#<code>`
 * - the app link the page opens, `huubhuub://pair?server=<url>&code=<code>`
 */
export function parseInvite(text: string): Invite | null {
  const raw = text.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol === "huubhuub:") {
    const server = url.searchParams.get("server")
    const code = url.searchParams.get("code")
    return server && code && isHttp(server) ? { server: trimSlash(server), code } : null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  const code = url.hash.slice(1)
  const match = url.pathname.match(/^(.*)\/pair\/?$/)
  if (!code || !match) return null
  return { server: trimSlash(`${url.origin}${match[1]}`), code }
}

function isHttp(s: string): boolean {
  return /^https?:\/\/[^/]+/.test(s)
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "")
}
