import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isProbablyText, sniffImage } from "./chats"
import { loadConfig, parseModelRef } from "./config"
import { chunkText, describeTool, markdownToHtml } from "./format"
import { Store } from "./store"

describe("markdownToHtml", () => {
  test("escapes HTML and renders inline styles", () => {
    expect(markdownToHtml("a < b & **bold** `x<y`")).toBe("a &lt; b &amp; <b>bold</b> <code>x&lt;y</code>")
  })

  test("renders fenced code blocks without touching their contents", () => {
    expect(markdownToHtml("```ts\nconst a = **1**\n```")).toBe(
      '<pre><code class="language-ts">const a = **1**</code></pre>',
    )
  })

  test("handles an unterminated fence while streaming", () => {
    expect(markdownToHtml("hi\n```\npartial")).toBe("hi\n<pre><code>partial</code></pre>")
  })

  test("renders headings, lists and links", () => {
    expect(markdownToHtml("# Title\n- item\n[x](https://a.b/c)")).toBe(
      '<b>Title</b>\n• item\n<a href="https://a.b/c">x</a>',
    )
  })

  test("does not italicise snake_case identifiers", () => {
    expect(markdownToHtml("use my_var_name here")).toBe("use my_var_name here")
  })
})

describe("chunkText", () => {
  test("returns short text unchanged", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"])
  })

  test("splits on newlines under the limit", () => {
    const chunks = chunkText("aaaa\nbbbb\ncccc", 10)
    expect(chunks.every((c) => c.length <= 14)).toBe(true)
    expect(chunks.join("\n")).toContain("cccc")
  })

  test("keeps code fences balanced across chunks", () => {
    const text = "```\n" + "line\n".repeat(40) + "```"
    for (const chunk of chunkText(text, 60)) expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
  })
})

describe("describeTool", () => {
  test("uses the most relevant input field", () => {
    expect(describeTool("shell", { command: "ls   -la" })).toBe("shell: ls -la")
    expect(describeTool("read", { filePath: "/a/b.ts" })).toBe("read: /a/b.ts")
    expect(describeTool("todo", {})).toBe("todo")
  })
})

describe("config", () => {
  test("parses the allowlist", () => {
    const c = loadConfig({ TELEGRAM_BOT_TOKEN: "t", ALLOWED_USER_IDS: "1, 22 ,333" })
    expect(c.ALLOWED_USER_IDS).toEqual([1, 22, 333])
    expect(c.WORKSPACE_DIR).toBe("/workspace")
  })

  test("rejects an invalid allowlist", () => {
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t", ALLOWED_USER_IDS: "abc" })).toThrow()
  })

  test("parses model references with slashes in the model ID", () => {
    expect(parseModelRef("openrouter/anthropic/claude")).toEqual({ providerID: "openrouter", id: "anthropic/claude" })
    expect(() => parseModelRef("nope")).toThrow()
  })
})

describe("file sniffing", () => {
  test("detects images by magic bytes", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("image/png")
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
    expect(sniffImage(new TextEncoder().encode("hello"))).toBeUndefined()
  })

  test("detects text vs binary", () => {
    expect(isProbablyText(new TextEncoder().encode("héllo\nworld"))).toBe(true)
    expect(isProbablyText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))).toBe(false)
  })
})

describe("Store", () => {
  test("persists chat → session mappings", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"))
    const store = new Store(dir)
    expect(store.get(1)).toBeUndefined()
    store.set(1, "ses_a")
    store.set(1, "ses_b")
    expect(store.get(1)).toEqual({ chatId: 1, sessionID: "ses_b" })
    store.close()
    const reopened = new Store(dir)
    expect(reopened.get(1)?.sessionID).toBe("ses_b")
    reopened.delete(1)
    expect(reopened.get(1)).toBeUndefined()
    reopened.close()
  })
})
