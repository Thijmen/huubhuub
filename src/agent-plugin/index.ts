/**
 * Loaded into the bot's `opencode serve`. Gives the agent tools to manage scheduled tasks and its memory,
 * adds the user's persona and memories to the system prompt, and hands every shell command a fresh GitHub
 * App token as GH_TOKEN so `gh` works. All of it goes through the bot's loopback API, whose address and
 * token are in the environment.
 */
import type { Plugin } from "@opencode/plugin/promise/plugin"

const WHEN =
  'When to run, in the bot\'s time zone: a cron expression ("0 8 * * 1-5"), "@hourly", "@daily 08:30", "every 30m" / "every 2h", or once: "in 2h", "at 18:00", "at 2026-10-01 09:00".'

const fields = {
  name: { type: "string", description: "Short name shown in lists. Defaults to the start of the prompt or command." },
  when: { type: "string", description: WHEN },
  type: {
    type: "string",
    enum: ["prompt", "command"],
    description: '"prompt" (default) sends `prompt` to an agent in a fresh session. "command" runs the shell `command` in the workspace and reports its output; no model is used.',
  },
  prompt: { type: "string", description: "For prompt tasks: the instructions the scheduled agent gets. Write them so they stand on their own; the run doesn't see this conversation." },
  command: {
    type: "string",
    description:
      "For command tasks: the bash command to run. For prompt tasks, an optional pre-check: the prompt only runs when this command exits 0 and prints something, and its output is appended to the prompt. Use it for cheap polling, e.g. `gh pr list --repo acme/api --label needs-review`.",
  },
  silent: { type: "boolean", description: "Only post a result when there's something to report. Default false." },
  deliver: {
    type: "string",
    enum: ["chat", "background"],
    description: '"chat" posts results in this Telegram chat (the default when there is one). "background" only records them on the admin UI\'s Schedules page.',
  },
} as const

const id = { type: "integer", description: "The schedule's number, from schedule_list." } as const

const TOOLS = [
  {
    name: "schedule_list",
    description: "List the scheduled tasks you can see from this conversation: what they do, when they run next, and whether they're paused.",
    input: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "schedule_create",
    description:
      "Schedule a task that runs later or repeatedly on its own: reminders, recurring reports, periodic checks, or anything the user wants done at a set time. Each run starts fresh, without this conversation. Unless the user spelled out exactly what they want, confirm the timing and wording with them first.",
    input: { type: "object", properties: fields, required: ["when"], additionalProperties: false },
  },
  {
    name: "schedule_update",
    description: "Change a scheduled task: its timing, prompt, command, name or delivery, or pause and resume it. Only the fields you pass change.",
    input: {
      type: "object",
      properties: { id, ...fields, when: { ...fields.when, description: `New timing. ${WHEN}` }, paused: { type: "boolean", description: "true pauses the task, false resumes it." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  { name: "schedule_delete", description: "Delete a scheduled task and its run history.", input: { type: "object", properties: { id }, required: ["id"], additionalProperties: false } },
  { name: "schedule_run", description: "Run a scheduled task right now, outside its schedule.", input: { type: "object", properties: { id }, required: ["id"], additionalProperties: false } },
]

const memoryId = { type: "integer", description: "The memory's number, as listed in the system prompt." } as const
const memoryText = { type: "string", description: "One short, self-contained sentence, written about the user in the third person." } as const

const MEMORY_TOOLS = [
  {
    name: "memory_save",
    description:
      "Save something about the user to long-term memory, so it's known in future conversations. Follow the memory rules in the system prompt about when to use this.",
    input: { type: "object", properties: { text: memoryText }, required: ["text"], additionalProperties: false },
  },
  {
    name: "memory_update",
    description: "Correct or extend an existing memory instead of saving a near-duplicate.",
    input: { type: "object", properties: { id: memoryId, text: memoryText }, required: ["id", "text"], additionalProperties: false },
  },
  {
    name: "memory_forget",
    description: "Delete a memory, e.g. when the user asks you to forget it or it's no longer true.",
    input: { type: "object", properties: { id: memoryId }, required: ["id"], additionalProperties: false },
  },
]
const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name))

async function call(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const url = process.env.BOT_INTERNAL_URL
  if (!url) throw new Error("The bot's internal API isn't configured.")
  return fetch(`${url}${path}`, {
    ...init,
    signal,
    headers: { authorization: `Bearer ${process.env.BOT_INTERNAL_TOKEN ?? ""}`, "content-type": "application/json" },
  })
}

const plugin: Plugin = {
  id: "telegram-bot",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      for (const tool of MEMORY_TOOLS) {
        const op = tool.name.slice("memory_".length)
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          execute: async (input, context) => {
            const res = await call(`/agent/memory/${op}`, { method: "POST", body: JSON.stringify({ ...(input as object), sessionID: context.sessionID }) }, context.signal)
            const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
            if (!res.ok) throw new Error(body.error ?? `The bot answered ${res.status}.`)
            return { content: body.text ?? "" }
          },
        })
      }
      for (const tool of TOOLS) {
        const op = tool.name.slice("schedule_".length)
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          execute: async (input, context) => {
            const res = await call(`/agent/schedules/${op}`, { method: "POST", body: JSON.stringify({ ...(input as object), sessionID: context.sessionID }) }, context.signal)
            const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
            if (!res.ok) throw new Error(body.error ?? `The bot answered ${res.status}.`)
            return { content: body.text ?? "" }
          },
        })
      }
    })

    // Runs before every model request, so persona and memory edits apply on the next turn.
    await ctx.session.hook("context", async (request) => {
      let context: { system: string | null; memory: boolean } = { system: null, memory: false }
      try {
        const res = await call(`/agent/context?sessionID=${encodeURIComponent(request.sessionID)}`, {}, AbortSignal.timeout(5000))
        if (res.ok) context = (await res.json()) as typeof context
      } catch (err) {
        console.error("Couldn't load the persona and memories for this session", err)
      }
      if (context.system) request.system.push({ type: "text", text: context.system })
      // With Code Mode, plugin tools are listed in the system prompt rather than here; the bot then refuses the calls instead.
      if (!context.memory) for (const name of MEMORY_TOOL_NAMES) delete request.tools[name]
    })

    // A token set by hand (say, a pasted PAT) wins over the app's.
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return
    await ctx.shell.hook("create.before", async (event) => {
      if (event.env.GH_TOKEN) return
      try {
        // The command lets the bot pick the account it's about, e.g. an organization rather than the default.
        const q = new URLSearchParams({ cwd: event.cwd, command: event.command.slice(0, 4000) })
        const res = await call(`/github/token?${q}`, {}, AbortSignal.timeout(5000))
        if (res.status === 200) event.env.GH_TOKEN = await res.text()
      } catch (err) {
        console.error("Couldn't get a GitHub token for this shell command", err)
      }
    })
  },
}

export default plugin
