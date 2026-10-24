/**
 * Loaded into the bot's `opencode serve`. Gives the agent tools to manage scheduled tasks, and hands every
 * shell command a fresh GitHub App token as GH_TOKEN so `gh` works. Both go through the bot's loopback API,
 * whose address and token are in the environment.
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

    // A token set by hand (say, a pasted PAT) wins over the app's.
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return
    await ctx.shell.hook("create.before", async (event) => {
      if (event.env.GH_TOKEN) return
      try {
        const res = await call(`/github/token?cwd=${encodeURIComponent(event.cwd)}`, {}, AbortSignal.timeout(5000))
        if (res.status === 200) event.env.GH_TOKEN = await res.text()
      } catch (err) {
        console.error("Couldn't get a GitHub token for this shell command", err)
      }
    })
  },
}

export default plugin
