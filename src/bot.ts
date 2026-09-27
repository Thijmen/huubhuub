import { Bot, InlineKeyboard, type Context } from "grammy"
import type { Config } from "./config"
import type { Bridge } from "./opencode"
import { Chats, keyOf, UserError } from "./chats"
import { threadParams } from "./reply"
import { truncate } from "./format"

const PAGE_SIZE = 8

export function createBot(config: Config, bridge: Bridge, chats: (bot: Bot) => Chats): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN)
  const chat = chats(bot)

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id
    if (id && config.ALLOWED_USER_IDS.includes(id)) return next()
    if (ctx.message?.text === "/start" || ctx.message?.text === "/whoami") {
      const hint = config.ALLOWED_USER_IDS.length === 0 ? " Add it to the allowlist in the admin UI." : ""
      await ctx.reply(`⛔ Not authorised. Your Telegram user ID is ${id ?? "unknown"}.${hint}`)
    }
  })

  bot.command(["start", "help"], (ctx) =>
    ctx.reply(
      [
        "👋 I'm an OpenCode agent. Send text, images, files or voice notes.",
        "",
        "/new – start a new conversation (a new thread when topics are on)",
        "/stop – interrupt the current run",
        "/model – switch model",
        "/agent – switch agent",
        "/status – session info",
        "/whoami – show your Telegram user ID",
      ].join("\n"),
    ),
  )

  bot.command("whoami", (ctx) => ctx.reply(`Your Telegram user ID is ${ctx.from?.id}.`))

  bot.command("new", async (ctx) => {
    const started = await chat.startNew(ctx)
    const prompt = ctx.match.trim()
    const text = started.topic
      ? `🆕 New conversation <code>${started.sessionID}</code>. ${prompt ? "" : "Send your first message here."}`
      : `🆕 New session <code>${started.sessionID}</code>`
    await ctx.api.sendMessage(started.key.chatId, text.trim(), { parse_mode: "HTML", ...threadParams(started.key) })
    if (prompt) await chat.send(started.key, prompt)
  })

  bot.command("stop", async (ctx) => {
    const view = await chat.view(keyOf(ctx))
    await bridge.interrupt(view.sessionID)
    if (!view.busy) await ctx.reply("Nothing is running.")
  })

  bot.command("status", async (ctx) => {
    const view = await chat.view(keyOf(ctx))
    const s = await bridge.getSession(view.sessionID)
    const t = s.tokens
    await ctx.reply(
      [
        `<b>Session</b> <code>${s.id}</code>`,
        s.title ? `<b>Title</b> ${escape(s.title)}` : "",
        `<b>Model</b> ${s.model ? `${s.model.providerID}/${s.model.id}` : "default"}`,
        `<b>Agent</b> ${s.agent ?? "default"}`,
        `<b>State</b> ${view.busy ? "running" : "idle"}`,
        `<b>Thread</b> ${view.key.threadId || "main chat"}${chat.threaded(ctx.chat) ? " (topics on)" : ""}`,
        `<b>Tokens</b> ${t.input} in / ${t.output} out / ${t.cache.read} cached`,
        `<b>Cost</b> $${s.cost.toFixed(4)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      { parse_mode: "HTML" },
    )
  })

  bot.command("model", async (ctx) => {
    const query = ctx.match.trim()
    if (query.includes("/") && !query.includes(" ")) return applyModel(ctx, query)
    await ctx.reply("Pick a provider:", { reply_markup: await providerKeyboard(bridge, query) })
  })

  bot.command("agent", async (ctx) => {
    const name = ctx.match.trim()
    if (name) return applyAgent(ctx, name)
    const agents = await bridge.agents()
    const kb = new InlineKeyboard()
    agents.forEach((a, i) => {
      kb.text(a.name, `a:${a.id}`)
      if (i % 2 === 1) kb.row()
    })
    await ctx.reply("Pick an agent:", { reply_markup: kb })
  })

  bot.callbackQuery(/^p:(.+):(\d+)$/, async (ctx) => {
    const [, provider, page] = ctx.match
    await ctx.editMessageText(`Pick a model from <b>${escape(provider!)}</b>:`, {
      parse_mode: "HTML",
      reply_markup: await modelKeyboard(bridge, provider!, Number(page)),
    })
    await ctx.answerCallbackQuery()
  })

  bot.callbackQuery("providers", async (ctx) => {
    await ctx.editMessageText("Pick a provider:", { reply_markup: await providerKeyboard(bridge, "") })
    await ctx.answerCallbackQuery()
  })

  bot.callbackQuery(/^m:(.+)$/, async (ctx) => {
    const models = await bridge.models()
    const model = models.find((m) => shortKey(m.providerID, m.id) === ctx.match[1])
    if (!model) return ctx.answerCallbackQuery({ text: "Model no longer available" })
    await applyModel(ctx, `${model.providerID}/${model.id}`)
    await ctx.answerCallbackQuery({ text: model.name })
  })

  bot.callbackQuery(/^a:(.+)$/, async (ctx) => {
    await applyAgent(ctx, ctx.match[1]!)
    await ctx.answerCallbackQuery()
  })

  async function applyModel(ctx: Context, ref: string) {
    const slash = ref.indexOf("/")
    const model = { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }
    const known = (await bridge.models()).some((m) => m.providerID === model.providerID && m.id === model.id)
    if (!known) return void (await ctx.reply(`Unknown model ${ref}. Try /model to browse.`))
    const view = await chat.view(keyOf(ctx))
    await bridge.switchModel(view.sessionID, model)
    await ctx.reply(`🧠 Model set to <code>${escape(ref)}</code>`, { parse_mode: "HTML" })
  }

  async function applyAgent(ctx: Context, name: string) {
    const agents = await bridge.agents()
    const agent = agents.find((a) => a.id === name || a.name.toLowerCase() === name.toLowerCase())
    if (!agent) return void (await ctx.reply(`Unknown agent ${name}. Available: ${agents.map((a) => a.id).join(", ")}`))
    const view = await chat.view(keyOf(ctx))
    await bridge.switchAgent(view.sessionID, agent.id)
    await ctx.reply(`🤖 Agent set to <b>${escape(agent.name)}</b>`, { parse_mode: "HTML" })
  }

  bot.on("message:text", (ctx) => chat.handleText(ctx))
  bot.on("message:photo", (ctx) => chat.handlePhoto(ctx))
  bot.on("message:document", (ctx) => chat.handleDocument(ctx))
  bot.on(["message:voice", "message:audio"], (ctx) => chat.handleVoice(ctx))

  bot.catch(async (err) => {
    const e = err.error
    console.error(`update ${err.ctx.update.update_id} failed`, e)
    const text = e instanceof UserError ? `⚠️ ${e.message}` : `⚠️ Error: ${truncate(String((e as Error)?.message ?? e), 300)}`
    await err.ctx.reply(text).catch(() => {})
  })

  return bot
}

async function providerKeyboard(bridge: Bridge, filter: string): Promise<InlineKeyboard> {
  const models = await bridge.models()
  const counts = new Map<string, number>()
  for (const m of models) {
    if (filter && !`${m.providerID}/${m.id} ${m.name}`.toLowerCase().includes(filter.toLowerCase())) continue
    counts.set(m.providerID, (counts.get(m.providerID) ?? 0) + 1)
  }
  const kb = new InlineKeyboard()
  ;[...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([p, n], i) => {
      kb.text(`${p} (${n})`, `p:${p}:0`)
      if (i % 2 === 1) kb.row()
    })
  return kb
}

async function modelKeyboard(bridge: Bridge, provider: string, page: number): Promise<InlineKeyboard> {
  const models = (await bridge.models())
    .filter((m) => m.providerID === provider)
    .sort((a, b) => b.time.released - a.time.released)
  const kb = new InlineKeyboard()
  for (const m of models.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    kb.text(truncate(m.name || m.id, 40), `m:${shortKey(m.providerID, m.id)}`).row()
  }
  if (page > 0) kb.text("◀ Prev", `p:${provider}:${page - 1}`)
  kb.text("↩ Providers", "providers")
  if ((page + 1) * PAGE_SIZE < models.length) kb.text("Next ▶", `p:${provider}:${page + 1}`)
  return kb
}

/** Telegram callback data is capped at 64 bytes, so reference models by a short hash. */
function shortKey(providerID: string, id: string): string {
  return Bun.hash(`${providerID}/${id}`).toString(36)
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
