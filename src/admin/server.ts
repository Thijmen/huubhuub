import type { Bot } from "grammy"
import { timingSafeEqual } from "node:crypto"
import type { Chats } from "../chats"
import { isRuntimeSetting, PROTECTED_ENV, type Settings } from "../settings"
import type { Config } from "../config"
import { isEnvName, mask, parseEnvText, planEnvImport } from "../env-import"
import { normalizeServer, parseMcpImport } from "../mcp-import"
import type { Bridge, McpConfig } from "../opencode"
import { cleanMemory, MemoryError, PERSONA_MAX_CHARS, type Personas } from "../personas"
import type { QuestionAction } from "../question"
import { describe, SpecError } from "../schedule-spec"
import type { ScheduleService, TaskInput } from "../schedule-service"
import type { Scheduler } from "../scheduler"
import type { GitHubAccess } from "../github-access"
import type { GitHubApp } from "../github-app"
import { SkillError, type SkillSources } from "../skills"
import { MEMORY_MODES, type ChatState, type MemoryMode, type Schedule, type Store } from "../store"
import { conversation, eventStream, toolCalls } from "./chat"
import index from "./web/index.html"

interface Deps {
  config: Config
  bridge: Bridge
  store: Store
  settings: Settings
  personas: Personas
  bot: Bot
  chats: Chats
  scheduler: Scheduler
  schedules: ScheduleService
  skills: SkillSources
  github: GitHubApp
  githubAccess: GitHubAccess
  token: string
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type Handler = (req: Bun.BunRequest, deps: Deps, server: Bun.Server<undefined>) => Promise<unknown> | unknown

export function startAdmin(deps: Deps) {
  const { config } = deps
  const started = Date.now()

  const api = (handler: Handler) => async (req: Bun.BunRequest, server: Bun.Server<undefined>) => {
    if (!authorised(req, deps.token)) return json({ error: "Unauthorised" }, 401)
    try {
      const result = await handler(req, deps, server)
      return result instanceof Response ? result : json(result ?? { ok: true })
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof SkillError || err instanceof SpecError || err instanceof MemoryError ? 400 : 500
      if (status === 500) console.error(`admin ${req.method} ${new URL(req.url).pathname} failed`, err)
      return json({ error: errorMessage(err) }, status)
    }
  }

  const server = Bun.serve({
    port: config.ADMIN_PORT,
    hostname: config.ADMIN_HOST,
    development: process.env.NODE_ENV !== "production" && { hmr: true, console: false },
    routes: {
      "/": index,
      "/api/overview": { GET: api((_, d) => overview(d, started)) },

      "/api/providers": { GET: api((_, d) => providers(d)) },
      "/api/providers/:id/key": {
        POST: api(async (req, d) => {
          const body = await read<{ key?: string; label?: string }>(req)
          if (!body.key?.trim()) throw new HttpError(400, "Paste an API key first.")
          await d.bridge.host.integration.connect.key({
            ...d.bridge.location,
            integrationID: param(req, "id"),
            key: body.key.trim(),
            ...(body.label?.trim() ? { label: body.label.trim() } : {}),
          })
        }),
      },
      "/api/providers/:id/oauth": {
        POST: api(async (req, d) => {
          const body = await read<{ methodID: string; answer?: Record<string, string | boolean | number> }>(req)
          const res = await d.bridge.host.integration.oauth.connect({
            ...d.bridge.location,
            integrationID: param(req, "id"),
            methodID: body.methodID,
            ...(body.answer ? { answer: body.answer } : {}),
          })
          return res.data
        }),
      },
      "/api/providers/:id/oauth/:attempt": {
        GET: api(async (req, d) => {
          const res = await d.bridge.host.integration.oauth.status({
            ...d.bridge.location,
            integrationID: param(req, "id"),
            attemptID: param(req, "attempt"),
          })
          return res.data
        }),
        POST: api(async (req, d) => {
          const body = await read<{ code?: string }>(req)
          await d.bridge.host.integration.oauth.complete({
            ...d.bridge.location,
            integrationID: param(req, "id"),
            attemptID: param(req, "attempt"),
            ...(body.code ? { code: body.code.trim() } : {}),
          })
        }),
        DELETE: api(async (req, d) => {
          await d.bridge.host.integration.oauth.cancel({
            ...d.bridge.location,
            integrationID: param(req, "id"),
            attemptID: param(req, "attempt"),
          })
        }),
      },
      "/api/credentials/:id": {
        DELETE: api(async (req, d) => void (await d.bridge.host.credential.remove({ credentialID: param(req, "id") }))),
      },
      "/api/credentials/:id/activate": {
        POST: api(async (req, d) => void (await d.bridge.host.credential.activate({ credentialID: param(req, "id") }))),
      },

      "/api/env": {
        GET: api((_, d) => ({
          vars: d.settings.envVars().map((v) => ({ name: v.name, masked: mask(v.value), updatedAt: v.updatedAt })),
          protected: [...PROTECTED_ENV],
        })),
      },
      "/api/env/preview": {
        POST: api(async (req, d) => {
          const { text } = await read<{ text: string }>(req)
          return previewEnv(d, text ?? "")
        }),
      },
      "/api/env/import": {
        POST: api(async (req, d) => {
          const { text } = await read<{ text: string }>(req)
          return importEnv(d, text ?? "")
        }),
      },
      "/api/env/:name": {
        PUT: api(async (req, d) => {
          const name = param(req, "name")
          const { value } = await read<{ value: string }>(req)
          if (!isEnvName(name)) throw new HttpError(400, `${name} isn't a valid variable name.`)
          if (typeof value !== "string" || !value) throw new HttpError(400, "A value is required.")
          d.settings.setEnv(name, value)
          await d.bridge.restart()
        }),
        DELETE: api(async (req, d) => {
          d.settings.deleteEnv(param(req, "name"))
          await d.bridge.restart()
        }),
      },

      "/api/opencode": { GET: api((req, d) => openCodeStatus(req, d)) },
      "/api/opencode/pair": {
        POST: api(async (req, d) => {
          if (d.bridge.server.status !== "running") throw new HttpError(503, "OpenCode isn't running right now.")
          return { url: await d.bridge.server.pairingLink(openCodeUrl(req, d.config)) }
        }),
      },

      "/api/mcp": {
        GET: api((_, d) => mcpServers(d)),
        POST: api(async (req, d) => {
          const body = await read<{ name: string; config: unknown }>(req)
          const name = body.name?.trim()
          if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new HttpError(400, "Use a name made of letters, digits, '.', '_' or '-'.")
          await saveMcp(d, name, normalizeServer(body.config))
        }),
      },
      "/api/mcp/import": {
        POST: api(async (req, d) => {
          const { text, name } = await read<{ text: string; name?: string }>(req)
          const parsed = parseMcpImport(text ?? "", name?.trim())
          for (const s of parsed.servers) await saveMcp(d, s.name, s.config)
          return { added: parsed.servers.map((s) => s.name), errors: parsed.errors }
        }),
      },
      "/api/mcp/:name": {
        DELETE: api(async (req, d) => {
          const name = param(req, "name")
          await d.bridge.host.mcp.remove({ ...d.bridge.location, server: name })
          if ((await fileMcpServers(d)).has(name)) d.store.setMcpServer(name, null)
          else d.store.deleteMcpServer(name)
        }),
      },
      "/api/mcp/:name/enabled": {
        PUT: api(async (req, d) => {
          const name = param(req, "name")
          const { enabled } = await read<{ enabled: boolean }>(req)
          const current = (await mcpServers(d)).find((s) => s.name === name)
          if (!current?.config) throw new HttpError(404, `No MCP server named ${name}.`)
          const { disabled: _, ...rest } = current.config as McpConfig & { disabled?: boolean }
          await saveMcp(d, name, (enabled ? rest : { ...rest, disabled: true }) as McpConfig)
        }),
      },
      "/api/mcp/:name/reconnect": {
        POST: api(async (req, d) => void (await d.bridge.host.mcp.connect({ ...d.bridge.location, server: param(req, "name") }))),
      },

      "/api/github": { GET: api((_, d) => githubStatus(d)) },
      "/api/github/default": {
        PUT: api(async (req, d) => {
          const { installationId } = await read<{ installationId: number | null }>(req)
          if (installationId !== null && !(await d.github.installations()).some((i) => i.id === installationId)) {
            throw new HttpError(400, "The app isn't installed there.")
          }
          d.githubAccess.setDefaultInstallation(installationId)
        }),
      },
      "/api/github/app": {
        GET: api((_, d) => ({ connected: d.github.connected(), info: d.github.info() })),
        DELETE: api(async (_, d) => {
          d.github.disconnect()
          d.githubAccess.setDefaultInstallation(null)
          await d.githubAccess.writeGitConfig()
        }),
      },
      "/api/github/app/start": {
        POST: api(async (req, d) => {
          const body = await read<{ origin: string; name?: string; org?: string }>(req)
          return d.github.startManifest(body.origin ?? "", body.name, body.org)
        }),
      },
      "/api/github/app/convert": {
        POST: api(async (req, d) => {
          const { code, state } = await read<{ code: string; state: string }>(req)
          const info = await d.github.convert(code ?? "", state ?? "")
          await d.githubAccess.writeGitConfig()
          return info
        }),
      },
      "/api/github/repos": {
        GET: api(async (_, d) => {
          const added = new Set(d.skills.list().map((s) => s.repo.toLowerCase()))
          return (await d.github.repositories()).map((r) => ({ ...r, added: added.has(r.repo.toLowerCase()) }))
        }),
      },

      "/api/skills": {
        GET: api((_, d) => d.skills.list()),
        POST: api(async (req, d) => {
          const body = await read<{ repo: string; ref?: string }>(req)
          return d.skills.add({ repo: body.repo ?? "", ref: body.ref })
        }),
      },
      "/api/skills/sync": {
        POST: api(async (_, d) => {
          await d.skills.sync()
          return d.skills.list()
        }),
      },
      "/api/skills/:id": {
        PATCH: api(async (req, d) => {
          const { ref } = await read<{ ref?: string | null }>(req)
          return d.skills.update(param(req, "id"), { ref })
        }),
        DELETE: api((req, d) => d.skills.remove(param(req, "id"))),
      },
      "/api/skills/:id/sync": {
        POST: api(async (req, d) => {
          const id = param(req, "id")
          d.skills.get(id)
          await d.skills.sync(id)
          return d.skills.get(id)
        }),
      },
      "/api/skills/:id/skills/:skill/enabled": {
        PUT: api(async (req, d) => {
          const { enabled } = await read<{ enabled: boolean }>(req)
          return d.skills.setEnabled(param(req, "id"), param(req, "skill"), Boolean(enabled))
        }),
      },

      "/api/settings": {
        GET: api(async (_, d) => {
          const [models, agents] = await Promise.all([d.bridge.models(), d.bridge.agents()])
          return {
            settings: d.settings.describe(),
            models: models.map((m) => ({ ref: `${m.providerID}/${m.id}`, name: m.name, provider: m.providerID })),
            agents: agents.map((a) => ({ id: a.id, name: a.name, description: a.description })),
          }
        }),
      },
      "/api/settings/:key": {
        PUT: api(async (req, d) => {
          const key = param(req, "key")
          if (!isRuntimeSetting(key)) throw new HttpError(404, `Unknown setting ${key}.`)
          const { value } = await read<{ value: string | null }>(req)
          try {
            d.settings.set(key, value === null ? undefined : String(value).trim())
          } catch (err) {
            throw new HttpError(400, errorMessage(err))
          }
          if (key === "SCHEDULE_TIMEZONE") d.scheduler.reschedule()
        }),
      },

      "/api/personas": {
        GET: api((_, d) => personasView(d)),
        POST: api(async (req, d) => {
          const body = personaInput(await read<{ name?: string; prompt?: string }>(req))
          if (d.store.personas().some((p) => p.name.toLowerCase() === body.name.toLowerCase())) throw new HttpError(400, `There's already a persona called ${body.name}.`)
          return d.store.createPersona(body.name, body.prompt)
        }),
      },
      "/api/personas/defaults": {
        PUT: api(async (req, d) => {
          const body = await read<{ personaId?: number | null; memoryMode?: MemoryMode | null }>(req)
          if (body.personaId !== undefined) d.personas.setDefaultPersona(body.personaId)
          if (body.memoryMode !== undefined) d.personas.setDefaultMemoryMode(body.memoryMode)
        }),
      },
      "/api/personas/:id": {
        PUT: api(async (req, d) => {
          const id = Number(param(req, "id"))
          const body = personaInput(await read<{ name?: string; prompt?: string }>(req))
          if (d.store.personas().some((p) => p.id !== id && p.name.toLowerCase() === body.name.toLowerCase())) throw new HttpError(400, `There's already a persona called ${body.name}.`)
          const updated = d.store.updatePersona(id, body)
          if (!updated) throw new HttpError(404, `There's no persona #${id}.`)
          return updated
        }),
        DELETE: api((req, d) => {
          const id = Number(param(req, "id"))
          if (d.personas.defaultPersonaId === id) d.personas.setDefaultPersona(null)
          d.store.deletePersona(id)
        }),
      },

      "/api/people": { GET: api((_, d) => peopleView(d)) },
      "/api/people/:id": {
        PUT: api(async (req, d) => {
          const id = userId(req)
          const body = await read<{ personaId?: number | null; memoryMode?: MemoryMode | null }>(req)
          if (body.personaId != null && !d.store.persona(body.personaId)) throw new HttpError(400, `There's no persona #${body.personaId}.`)
          if (body.memoryMode != null && !MEMORY_MODES.includes(body.memoryMode)) throw new HttpError(400, `Unknown memory mode ${body.memoryMode}.`)
          d.store.updatePerson(id, body)
        }),
      },
      "/api/people/:id/threads": { GET: api((req, d) => threadRows(d, d.store.threadsOf(userId(req)))) },
      "/api/threads/:sessionID/tools": {
        GET: api(async (req, d) => {
          const sessionID = param(req, "sessionID")
          knownSession(d, sessionID)
          return toolCalls(d.bridge, sessionID)
        }),
      },
      "/api/people/:id/prompt": { GET: api((req, d) => ({ prompt: d.personas.preview(userId(req)) })) },
      "/api/people/:id/memories": {
        POST: api(async (req, d) => {
          const { text } = await read<{ text?: string }>(req)
          return d.personas.add(userId(req), text, "admin")
        }),
        DELETE: api((req, d) => ({ removed: d.store.clearMemories(userId(req)) })),
      },
      "/api/memories/:id": {
        PUT: api(async (req, d) => {
          const id = Number(param(req, "id"))
          const { text } = await read<{ text?: string }>(req)
          const updated = d.store.memory(id) && d.store.updateMemory(id, cleanMemory(text))
          if (!updated) throw new HttpError(404, `There's no memory #${id}.`)
          return updated
        }),
        DELETE: api((req, d) => d.store.deleteMemory(Number(param(req, "id")))),
      },

      "/api/schedules": {
        GET: api((_, d) => schedules(d)),
        POST: api(async (req, d) => {
          const body = await read<TaskInput & { chatId: number | null }>(req)
          const s = await d.schedules.create({ ...body, chatId: chatOrThrow(d, body.chatId) })
          return scheduleView(d, s)
        }),
      },
      "/api/schedules/preview": {
        POST: api(async (req, d) => {
          const { when } = await read<{ when: string }>(req)
          return d.schedules.preview(when ?? "")
        }),
      },
      "/api/schedules/:id": {
        PUT: api(async (req, d) => {
          const s = scheduleOrThrow(d, param(req, "id"))
          const body = await read<TaskInput>(req)
          if (body.chatId !== undefined) chatOrThrow(d, body.chatId)
          return scheduleView(d, await d.schedules.update(s, body))
        }),
        DELETE: api((req, d) => d.schedules.delete(scheduleOrThrow(d, param(req, "id")))),
      },
      "/api/schedules/:id/run": {
        POST: api((req, d) => {
          const s = scheduleOrThrow(d, param(req, "id"))
          try {
            d.scheduler.runNow(s.id)
          } catch (err) {
            if (err instanceof SpecError) throw new HttpError(409, err.message)
            throw err
          }
        }),
      },

      "/api/threads": {
        GET: api((_, d) => threads(d)),
        POST: api(async (req, d) => {
          const { chatId } = await read<{ chatId: number }>(req)
          if (!Number.isSafeInteger(chatId)) throw new HttpError(400, "Pick a chat to start the conversation in.")
          if (!d.store.latest(chatId)) throw new HttpError(404, "The bot hasn't talked in that chat yet.")
          const started = await d.chats.startFromPortal(chatId)
          return { sessionID: started.sessionID, ...started.key }
        }),
      },
      "/api/threads/:sessionID": {
        GET: api(async (req, d) => {
          const sessionID = param(req, "sessionID")
          knownSession(d, sessionID)
          const page = await conversation(d.bridge, d.store, d.chats.questions, sessionID, new URL(req.url).searchParams.get("cursor") ?? undefined)
          return { ...page, bot: d.bot.isInited() ? d.bot.botInfo.username : null }
        }),
      },
      "/api/threads/:sessionID/events": {
        GET: api((req, d, server) => {
          const sessionID = param(req, "sessionID")
          knownSession(d, sessionID)
          server.timeout(req, 0)
          return eventStream(d.bridge, d.chats.questions, sessionID, req.signal)
        }),
      },
      "/api/threads/:sessionID/prompt": {
        POST: api(async (req, d) => {
          const sessionID = param(req, "sessionID")
          knownSession(d, sessionID)
          const { text } = await read<{ text: string }>(req)
          if (!text?.trim()) throw new HttpError(400, "Type a message first.")
          await d.chats.sendFromPortal(sessionID, text.trim())
        }),
      },
      "/api/threads/:sessionID/question": {
        POST: api(async (req, d) => {
          const sessionID = param(req, "sessionID")
          knownSession(d, sessionID)
          const body = await read<{ formID: string; action: QuestionAction }>(req)
          const ok = await d.chats.questions.act(sessionID, body.formID, body.action)
          if (!ok) throw new HttpError(409, "This question has already been answered.")
          return d.chats.questions.pending(sessionID)?.snapshot() ?? null
        }),
      },
      "/api/threads/:sessionID/stop": {
        POST: api(async (req, d) => {
          const sessionID = param(req, "sessionID")
          knownSession(d, sessionID)
          await d.bridge.interrupt(sessionID)
        }),
      },
      "/api/threads/:sessionID/model": {
        PUT: api(async (req, d) => {
          const sessionID = param(req, "sessionID")
          knownSession(d, sessionID)
          const { ref } = await read<{ ref: string }>(req)
          const slash = ref?.indexOf("/") ?? -1
          if (slash < 1) throw new HttpError(400, "Use provider/model.")
          const model = { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }
          if (!(await d.bridge.models()).some((m) => m.providerID === model.providerID && m.id === model.id)) {
            throw new HttpError(400, `${ref} isn't available.`)
          }
          await d.bridge.switchModel(sessionID, model)
        }),
      },
      "/api/threads/:sessionID/agent": {
        PUT: api(async (req, d) => {
          const sessionID = param(req, "sessionID")
          knownSession(d, sessionID)
          const { agent } = await read<{ agent: string }>(req)
          if (!(await d.bridge.agents()).some((a) => a.id === agent)) throw new HttpError(400, `Unknown agent ${agent}.`)
          await d.bridge.switchAgent(sessionID, agent)
        }),
      },
    },
    fetch: () => json({ error: "Not found" }, 404),
    error: (err) => json({ error: errorMessage(err) }, 500),
  })
  return server
}

async function overview(d: Deps, started: number) {
  const me = await d.bot.api.getMe().catch(() => undefined)
  if (me) d.bot.botInfo = me
  const [models, integrations, mcp] = await Promise.all([
    d.bridge.models(),
    d.bridge.host.integration.list(d.bridge.location),
    d.bridge.host.mcp.list(d.bridge.location),
  ])
  const byProvider = countBy(models.map((m) => m.providerID))
  return {
    bot: me
      ? {
          username: me.username,
          name: me.first_name,
          topics: me.has_topics_enabled,
          usersCreateTopics: me.allows_users_to_create_topics,
        }
      : undefined,
    threadMode: d.config.THREAD_MODE,
    allowedUsers: d.config.ALLOWED_USER_IDS,
    defaultModel: d.config.DEFAULT_MODEL ?? null,
    defaultAgent: d.config.DEFAULT_AGENT ?? null,
    models: models.length,
    providers: integrations.data
      .filter((i) => i.connections.length > 0 || byProvider.has(i.id))
      .map((i) => ({ id: i.id, name: i.name, models: byProvider.get(i.id) ?? 0 })),
    mcp: mcp.data.map((s) => ({ name: s.name, status: s.status.status })),
    conversations: d.store.list(1000).length,
    uptime: Date.now() - started,
    version: Bun.version,
  }
}

async function providers(d: Deps) {
  const [integrations, models, provs] = await Promise.all([
    d.bridge.host.integration.list(d.bridge.location),
    d.bridge.models(),
    d.bridge.host.provider.list(d.bridge.location),
  ])
  const byProvider = countBy(models.map((m) => m.providerID))
  const integrationIds = new Set(integrations.data.map((i) => i.id))
  const list = integrations.data.map((i) => ({
    id: i.id,
    name: i.name,
    methods: i.methods,
    connections: i.connections.map((c) =>
      c.type === "env" ? { ...c, masked: process.env[c.name] ? mask(process.env[c.name]!) : "" } : c,
    ),
    models: byProvider.get(i.id) ?? 0,
  }))
  // Providers defined in bot.opencode.jsonc have no integration entry but still contribute models.
  const custom = provs.data
    .filter((p) => !integrationIds.has(p.integrationID ?? p.id))
    .map((p) => ({ id: p.id, name: p.name, methods: [], connections: [], models: byProvider.get(p.id) ?? 0, custom: true }))
  return [...list, ...custom].sort((a, b) => a.name.localeCompare(b.name))
}

async function previewEnv(d: Deps, text: string) {
  const { entries, errors } = parseEnvText(text)
  const integrations = await d.bridge.host.integration.list(d.bridge.location)
  const plan = planEnvImport(entries, integrations.data).map((p) => ({
    ...p,
    protected: PROTECTED_ENV.has(p.name),
    exists: process.env[p.name] !== undefined,
  }))
  return { plan, errors }
}

async function importEnv(d: Deps, text: string) {
  const { entries } = parseEnvText(text)
  const integrations = await d.bridge.host.integration.list(d.bridge.location)
  const plan = planEnvImport(entries, integrations.data)
  const values = new Map(entries.map((e) => [e.name, e.value]))
  const results: { name: string; ok: boolean; action: string; message?: string }[] = []
  let envChanged = false
  for (const item of plan) {
    const value = values.get(item.name)!
    try {
      if (PROTECTED_ENV.has(item.name)) throw new Error("set this in the container environment instead")
      if (item.action === "credential" && item.integration) {
        await d.bridge.host.integration.connect.key({
          ...d.bridge.location,
          integrationID: item.integration.id,
          key: value,
          label: `Pasted ${item.name}`,
        })
      } else {
        d.settings.setEnv(item.name, value)
        envChanged = true
      }
      results.push({ name: item.name, ok: true, action: item.action })
    } catch (err) {
      results.push({ name: item.name, ok: false, action: item.action, message: errorMessage(err) })
    }
  }
  // OpenCode runs in its own process and only reads the environment at startup.
  if (envChanged) await d.bridge.restart()
  return { results, models: (await d.bridge.models()).length }
}

async function openCodeStatus(req: Request, d: Deps) {
  const s = d.bridge.server
  return {
    status: s.status,
    version: s.version,
    url: openCodeUrl(req, d.config),
    uptime: s.startedAt && s.status === "running" ? Date.now() - s.startedAt : null,
    restarts: s.restarts,
  }
}

/** Where the browser reaches the OpenCode web UI: OPENCODE_PUBLIC_URL, or the admin's host on OPENCODE_PORT. */
function openCodeUrl(req: Request, config: Config): string {
  if (config.OPENCODE_PUBLIC_URL) return config.OPENCODE_PUBLIC_URL
  return `http://${new URL(req.url).hostname}:${config.OPENCODE_PORT}`
}

async function fileMcpServers(d: Deps): Promise<Map<string, McpConfig>> {
  const entries = await d.bridge.host.config.get(d.bridge.location)
  const out = new Map<string, McpConfig>()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const [name, cfg] of Object.entries(entry.info.mcp?.servers ?? {})) out.set(name, cfg as McpConfig)
  }
  return out
}

async function mcpServers(d: Deps) {
  const [status, file] = await Promise.all([d.bridge.host.mcp.list(d.bridge.location), fileMcpServers(d)])
  const overrides = new Map(d.store.mcpServers().map((r) => [r.name, r.config]))
  return status.data.map((s) => {
    const override = overrides.get(s.name)
    return {
      name: s.name,
      status: s.status.status,
      error: "error" in s.status ? s.status.error : undefined,
      source: override ? ("admin" as const) : ("config" as const),
      config: (override ?? file.get(s.name) ?? null) as McpConfig | null,
      integrationID: s.integrationID,
    }
  })
}

async function saveMcp(d: Deps, name: string, config: McpConfig): Promise<void> {
  await d.bridge.host.mcp.add({ ...d.bridge.location, server: name, config })
  d.store.setMcpServer(name, config as unknown as Record<string, unknown>)
}

function threads(d: Deps) {
  return threadRows(d, d.store.list(100))
}

async function threadRows(d: Deps, rows: ChatState[]) {
  const active = await d.bridge.host.session.active().catch(() => ({}) as Record<string, unknown>)
  return Promise.all(
    rows.map(async (r) => {
      const s = await d.bridge.getSession(r.sessionID).catch(() => undefined)
      return {
        chatId: r.chatId,
        threadId: r.threadId,
        sessionID: r.sessionID,
        updatedAt: r.updatedAt,
        title: s?.title ?? null,
        model: s?.model ? `${s.model.providerID}/${s.model.id}` : null,
        agent: s?.agent ?? null,
        cost: s?.cost ?? 0,
        tokens: s ? s.tokens.input + s.tokens.output : 0,
        busy: r.sessionID in active,
        userId: r.userId ?? (r.chatId > 0 ? r.chatId : null),
      }
    }),
  )
}

async function githubStatus(d: Deps) {
  const info = d.github.info()
  const gh = await d.githubAccess.ghVersion()
  if (!info) return { connected: false, info: null, gh, installations: [], missingAppPermissions: [], identity: null, error: null }
  try {
    const [installations, missingAppPermissions, identity] = await Promise.all([
      d.githubAccess.installations(),
      d.githubAccess.missingAppPermissions(),
      d.github.identity().catch(() => null),
    ])
    return { connected: true, info, gh, installations, missingAppPermissions, identity, error: null }
  } catch (err) {
    return { connected: true, info, gh, installations: [], missingAppPermissions: [], identity: null, error: errorMessage(err) }
  }
}

function scheduleOrThrow(d: Deps, raw: string): Schedule {
  const s = d.store.schedule(Number(raw))
  if (!s) throw new HttpError(404, "No schedule with that ID.")
  return s
}

/** A chat to post in must be one the bot has talked in; null runs the job in the background. */
function chatOrThrow(d: Deps, chatId: number | null | undefined): number | null {
  if (chatId === null) return null
  if (!Number.isSafeInteger(chatId) || !d.store.latest(chatId!)) throw new HttpError(400, "Pick a chat the bot has talked in, or run it in the background.")
  return chatId!
}

function scheduleView(d: Deps, s: Schedule) {
  return {
    ...s,
    description: describe(s, d.config.SCHEDULE_TIMEZONE),
    running: d.scheduler.running(s.id),
    runs: d.store.runs(s.id, 15),
  }
}

const chatTitles = new Map<number, { title: string | null; at: number }>()

async function chatTitle(d: Deps, id: number): Promise<string | null> {
  const hit = chatTitles.get(id)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.title
  const chat = await d.bot.api.getChat(id).catch(() => undefined)
  const title = chat
    ? ("title" in chat && chat.title) || [("first_name" in chat && chat.first_name) || "", ("last_name" in chat && chat.last_name) || ""].join(" ").trim() || null
    : null
  chatTitles.set(id, { title, at: Date.now() })
  return title
}

async function schedules(d: Deps) {
  const list = d.store.schedules()
  const chatIds = [...new Set([...list.flatMap((s) => (s.chatId === null ? [] : [s.chatId])), ...d.store.list(1000).map((t) => t.chatId)])]
  const chats = await Promise.all(chatIds.map(async (id) => ({ id, title: await chatTitle(d, id) })))
  return { timeZone: d.config.SCHEDULE_TIMEZONE, chats, schedules: list.map((s) => scheduleView(d, s)) }
}

/** Only sessions bound to a Telegram thread, or started by a schedule, are exposed through the portal. */
function knownSession(d: Deps, sessionID: string): void {
  if (!d.store.bySession(sessionID) && !d.store.runBySession(sessionID)) throw new HttpError(404, "No conversation with that ID.")
}

function authorised(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? ""
  const given = header.startsWith("Bearer ") ? header.slice(7) : ""
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function personasView(d: Deps) {
  const people = d.store.people()
  return {
    personas: d.store.personas().map((p) => ({ ...p, users: people.filter((u) => u.personaId === p.id).length })),
    defaultPersonaId: d.personas.defaultPersonaId,
    defaultMemoryMode: d.personas.defaultMemoryMode,
  }
}

function personaInput(body: { name?: string; prompt?: string }): { name: string; prompt: string } {
  const name = body.name?.trim() ?? ""
  const prompt = body.prompt?.trim() ?? ""
  if (!name || name.length > 60) throw new HttpError(400, "Give the persona a name of up to 60 characters.")
  if (!prompt) throw new HttpError(400, "Write the persona's instructions first.")
  if (prompt.length > PERSONA_MAX_CHARS) throw new HttpError(400, `Keep the instructions under ${PERSONA_MAX_CHARS} characters.`)
  return { name, prompt }
}

/** Everyone who has written to the bot, plus allowlisted users who haven't yet. */
function peopleView(d: Deps) {
  const seen = d.store.people()
  const ids = new Set(seen.map((p) => p.id))
  const unseen = d.config.ALLOWED_USER_IDS.filter((id) => !ids.has(id)).map((id) => ({ id, name: null, username: null, personaId: null, memoryMode: null, seenAt: null }))
  return {
    defaultPersonaId: d.personas.defaultPersonaId,
    defaultMemoryMode: d.personas.defaultMemoryMode,
    personas: d.store.personas().map((p) => ({ id: p.id, name: p.name })),
    people: [...seen, ...unseen].map((p) => ({
      ...p,
      allowed: d.config.ALLOWED_USER_IDS.includes(p.id),
      memories: d.store.memories(p.id),
    })),
  }
}

function userId(req: Bun.BunRequest): number {
  const id = Number(param(req, "id"))
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "Expected a Telegram user ID.")
  return id
}

function param(req: Bun.BunRequest, name: string): string {
  return decodeURIComponent((req.params as Record<string, string>)[name] ?? "")
}

async function read<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new HttpError(400, "Expected a JSON body.")
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } })
}

function countBy(values: string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1)
  return out
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
  return String(err)
}
