import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { isProbablyText, sniffImage } from "./chats"
import { applySetting, loadConfig, parseModelRef } from "./config"
import { parseEnvText, planEnvImport } from "./env-import"
import { chunkText, describeTool, markdownToHtml } from "./format"
import { parseMcpImport, splitCommand } from "./mcp-import"
import { threadParams } from "./reply"
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
    expect(c.WORKSPACE_DIR).toBe(resolve("workspace"))
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: "t", DATA_DIR: "/data" }).DATA_DIR).toBe("/data")
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
  test("persists thread → session mappings", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"))
    const store = new Store(dir)
    const main = { chatId: 1, threadId: 0 }
    const topic = { chatId: 1, threadId: 42 }
    expect(store.get(main)).toBeUndefined()
    store.set(main, "ses_a")
    store.set(main, "ses_b")
    store.set(topic, "ses_c", true)
    expect(store.get(main)).toMatchObject({ chatId: 1, threadId: 0, sessionID: "ses_b", autoTitle: false })
    expect(store.get(topic)).toMatchObject({ sessionID: "ses_c", autoTitle: true })
    expect(store.bySession("ses_c")?.threadId).toBe(42)
    store.clearAutoTitle(topic)
    expect(store.get(topic)?.autoTitle).toBe(false)
    store.close()
    const reopened = new Store(dir)
    expect(reopened.get(main)?.sessionID).toBe("ses_b")
    expect(reopened.latest(1)).toBeDefined()
    reopened.delete(main)
    expect(reopened.get(main)).toBeUndefined()
    reopened.close()
  })

  test("migrates the legacy chats table", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"))
    const db = new Database(join(dir, "bot.sqlite"), { create: true })
    db.run("CREATE TABLE chats (chat_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL)")
    db.run("INSERT INTO chats VALUES (7, 'ses_old', 1)")
    db.close()
    const store = new Store(dir)
    expect(store.get({ chatId: 7, threadId: 0 })?.sessionID).toBe("ses_old")
    store.close()
  })

  test("stores settings, env vars and MCP overrides", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "store-")))
    store.setSetting("THREAD_MODE", "off")
    expect(store.getSetting("THREAD_MODE")).toBe("off")
    store.setSetting("THREAD_MODE", undefined)
    expect(store.getSetting("THREAD_MODE")).toBeUndefined()
    store.setEnvVar("FOO", "bar")
    expect(store.envVars().map((v) => v.name)).toEqual(["FOO"])
    store.setMcpServer("gone", null)
    store.setMcpServer("fs", { type: "local", command: ["x"] })
    expect(store.mcpServers()).toEqual([
      { name: "fs", config: { type: "local", command: ["x"] } },
      { name: "gone", config: null },
    ])
    store.close()
  })
})

describe("threadParams", () => {
  test("omits the thread for the main chat", () => {
    expect(threadParams({ chatId: 1, threadId: 0 })).toEqual({})
    expect(threadParams({ chatId: 1, threadId: 9 })).toEqual({ message_thread_id: 9 })
  })
})

describe("runtime settings", () => {
  test("applies and validates overrides", () => {
    const c = loadConfig({ TELEGRAM_BOT_TOKEN: "t" })
    expect(c.ALLOWED_USER_IDS).toEqual([])
    applySetting(c, "ALLOWED_USER_IDS", "5,6", {})
    expect(c.ALLOWED_USER_IDS).toEqual([5, 6])
    applySetting(c, "THREAD_MODE", "off", {})
    expect(c.THREAD_MODE).toBe("off")
    applySetting(c, "THREAD_MODE", undefined, {})
    expect(c.THREAD_MODE).toBe("auto")
    expect(() => applySetting(c, "DEFAULT_MODEL", "bad", {})).toThrow()
    applySetting(c, "DEFAULT_MODEL", undefined, { DEFAULT_MODEL: "a/b" })
    expect(c.DEFAULT_MODEL).toBe("a/b")
  })
})

describe("parseEnvText", () => {
  test("reads dotenv lines with quotes, export and comments", () => {
    const { entries, errors } = parseEnvText('# hi\nexport A="1 2"\nB=x # note\nC: \'y\'\n\nD=')
    expect(entries).toEqual([
      { name: "A", value: "1 2" },
      { name: "B", value: "x" },
      { name: "C", value: "y" },
    ])
    expect(errors).toEqual([])
  })

  test("reads JSON objects", () => {
    expect(parseEnvText('{"A":"1","B":2,"bad key":"x","C":{}}').entries).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ])
  })

  test("guesses names for bare keys", () => {
    const { entries, errors } = parseEnvText("sk-ant-abc123\nsk-or-v1-xyz\nwhat is this")
    expect(entries.map((e) => [e.name, e.guessed])).toEqual([
      ["ANTHROPIC_API_KEY", true],
      ["OPENROUTER_API_KEY", true],
    ])
    expect(errors).toHaveLength(1)
  })
})

describe("planEnvImport", () => {
  const integrations = [
    { id: "anthropic", name: "Anthropic", methods: [{ type: "key" }, { type: "env", names: ["ANTHROPIC_API_KEY"] }] },
    { id: "aws", name: "Bedrock", methods: [{ type: "env", names: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] }] },
  ]

  test("stores single-variable provider keys as credentials", () => {
    const plan = planEnvImport([{ name: "ANTHROPIC_API_KEY", value: "sk-ant-1234567890abcdef" }], integrations)
    expect(plan[0]).toMatchObject({ action: "credential", integration: { id: "anthropic" } })
    expect(plan[0]!.masked).not.toContain("1234567890")
  })

  test("keeps multi-variable and unknown names as env vars", () => {
    const plan = planEnvImport(
      [
        { name: "AWS_ACCESS_KEY_ID", value: "x" },
        { name: "OTHER", value: "y" },
      ],
      integrations,
    )
    expect(plan.map((p) => [p.action, p.integration?.id])).toEqual([
      ["env", "aws"],
      ["env", undefined],
    ])
  })
})

describe("parseMcpImport", () => {
  test("reads Claude Desktop style configs", () => {
    const { servers, errors } = parseMcpImport(
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "server-fs", "/w"], env: { A: "1" } },
          remote: { url: "https://x.dev/mcp", headers: { Authorization: "Bearer t" } },
        },
      }),
    )
    expect(errors).toEqual([])
    expect(servers).toEqual([
      { name: "fs", config: { type: "local", command: ["npx", "-y", "server-fs", "/w"], environment: { A: "1" } } },
      { name: "remote", config: { type: "remote", url: "https://x.dev/mcp", headers: { Authorization: "Bearer t" } } },
    ])
  })

  test("reads OpenCode configs with comments and trailing commas", () => {
    const { servers } = parseMcpImport('{ // c\n "mcp": { "servers": { "a": { "type": "local", "command": ["x"], "enabled": false, }, }, } }')
    expect(servers).toEqual([{ name: "a", config: { type: "local", command: ["x"], disabled: true } }])
  })

  test("needs a name for a single server", () => {
    expect(parseMcpImport('{"command":"x"}').errors).toEqual(["Give this server a name."])
    expect(parseMcpImport('{"command":"x"}', "one").servers[0]?.name).toBe("one")
  })

  test("reports invalid servers", () => {
    const { servers, errors } = parseMcpImport('{"mcpServers":{"a":{"type":"remote"},"b c":{"command":"x"}}}')
    expect(servers).toEqual([])
    expect(errors).toHaveLength(2)
  })
})

describe("splitCommand", () => {
  test("honours quotes", () => {
    expect(splitCommand(`npx -y "my server" 'a b' ""`)).toEqual(["npx", "-y", "my server", "a b", ""])
  })
})
