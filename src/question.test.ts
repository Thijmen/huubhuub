import { afterEach, describe, expect, test } from "bun:test"
import { parseAction, QuestionFlow, Questions, SKIP_NOTE, shortID, TIMEOUT_NOTE, toFields, trackForms, type AnswerValue, type QuestionField } from "./question"

const single: QuestionField = { key: "q0", title: "Colour", question: "Pick a colour", multiple: false, options: [{ label: "Red" }, { label: "Blue", description: "Calm" }] }
const multi: QuestionField = { key: "q1", title: "Toppings", question: "Which ones?", multiple: true, options: [{ label: "Cheese" }, { label: "Ham" }, { label: "Olives" }] }

function stub() {
  const replies: { sessionID: string; formID: string; answer: Record<string, AnswerValue> }[] = []
  const questions = new Questions({ reply: async (sessionID, formID, answer) => void replies.push({ sessionID, formID, answer }) }, () => 10)
  return { questions, replies }
}

let open: Questions[] = []
afterEach(() => {
  for (const q of open) q.dispose()
  open = []
})

describe("toFields", () => {
  test("maps question tool form fields", () => {
    const fields = toFields([
      { key: "q0", type: "string", title: "Colour", description: "Pick", options: [{ value: "Red", label: "Red", description: "Warm" }] },
      { key: "q1", type: "multiselect", options: [{ value: "a", label: "A" }] },
    ])
    expect(fields[0]).toEqual({ key: "q0", title: "Colour", question: "Pick", multiple: false, options: [{ label: "Red", description: "Warm" }] })
    expect(fields[1]!.multiple).toBe(true)
    expect(fields[1]!.title).toBe("Question")
  })
})

describe("QuestionFlow", () => {
  test("walks several questions one at a time", () => {
    const flow = new QuestionFlow("f", "s", [single, multi], 0, 600_000)
    expect(flow.render().html).toContain("(1/2)")
    expect(flow.pick(1)).toBe(false)
    expect(flow.index).toBe(1)
    flow.toggle(0)
    flow.toggle(2)
    flow.toggle(0)
    flow.toggle(0)
    expect(flow.render().keyboard[0]![0]!.text).toStartWith("☑")
    expect(flow.submit()).toBe(true)
    expect(flow.status).toBe("answered")
    expect(flow.answer()).toEqual({ q0: "Blue", q1: ["Cheese", "Olives"] })
    expect(flow.summary()).toContain("Toppings → <b>Cheese, Olives</b>")
  })

  test("typed text replaces ticked options", () => {
    const flow = new QuestionFlow("f", "s", [multi], 0, 600_000)
    flow.toggle(1)
    expect(flow.typed("  pineapple ")).toBe(true)
    expect(flow.answer()).toEqual({ q1: ["pineapple"] })
  })

  test("ignores the wrong action for the question type", () => {
    const flow = new QuestionFlow("f", "s", [single], 0, 600_000)
    flow.toggle(0)
    expect(flow.submit()).toBe(false)
    expect(flow.pick(5)).toBe(false)
    expect(flow.typed("   ")).toBe(false)
    expect(flow.done).toBe(false)
  })

  test("renders buttons and escapes HTML", () => {
    const flow = new QuestionFlow("f", "s", [{ ...single, title: "<b>x</b>" }], 0, 600_000)
    const { html, keyboard } = flow.render()
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;")
    expect(html).not.toContain("(1/1)")
    expect(html).toContain("<b>Blue</b>: Calm")
    expect(keyboard.map((r) => r.map((b) => b.action))).toEqual([["p:0"], ["p:1"], ["x"]])
  })

  test("fills unanswered questions with a note", () => {
    const flow = new QuestionFlow("f", "s", [single, multi], 0, 600_000)
    flow.pick(0)
    flow.finish("skipped")
    expect(flow.answer("note")).toEqual({ q0: "Red", q1: ["note"] })
    expect(flow.summary()).toContain("✖ Skipped")
  })

  test("summarises a timeout with the minutes", () => {
    const flow = new QuestionFlow("f", "s", [single], 0, 600_000)
    flow.finish("timeout")
    expect(flow.summary()).toContain("Timed out after 10 min")
  })
})

describe("Questions", () => {
  test("replies once every question is answered and notifies listeners", async () => {
    const { questions, replies } = stub()
    open.push(questions)
    const seen: string[] = []
    questions.subscribe("s", (f) => seen.push(`${f.status}:${f.index}`))
    questions.open("s", "form", [single, multi])
    expect(await questions.act("s", "form", { type: "pick", option: 0 })).toBe(true)
    expect(replies).toHaveLength(0)
    await questions.act("s", "form", { type: "text", text: "Anchovies" })
    expect(replies).toEqual([{ sessionID: "s", formID: "form", answer: { q0: "Red", q1: ["Anchovies"] } }])
    expect(seen).toEqual(["pending:0", "pending:1", "answered:1"])
    expect(questions.pending("s")).toBeUndefined()
  })

  test("first answer wins", async () => {
    const { questions, replies } = stub()
    open.push(questions)
    questions.open("s", "form", [single])
    await questions.act("s", "form", { type: "pick", option: 1 })
    expect(await questions.act("s", "form", { type: "pick", option: 0 })).toBe(false)
    expect(await questions.act("s", "other", { type: "skip" })).toBe(false)
    expect(replies).toHaveLength(1)
  })

  test("skip answers every question with a note", async () => {
    const { questions, replies } = stub()
    open.push(questions)
    questions.open("s", "form", [single, multi])
    await questions.act("s", "form", { type: "skip" })
    expect(replies[0]!.answer).toEqual({ q0: SKIP_NOTE, q1: [SKIP_NOTE] })
  })

  test("times out", async () => {
    const replies: Record<string, AnswerValue>[] = []
    const questions = new Questions({ reply: async (_s, _f, a) => void replies.push(a) }, () => 0.0005)
    open.push(questions)
    const flow = questions.open("s", "form", [single])
    await Bun.sleep(60)
    expect(flow.status).toBe("timeout")
    expect(replies).toEqual([{ q0: TIMEOUT_NOTE }])
  })

  test("closing from OpenCode does not reply", async () => {
    const { questions, replies } = stub()
    open.push(questions)
    const flow = questions.open("s", "form", [single])
    questions.close("s", "answered", "someone-else")
    expect(flow.done).toBe(false)
    questions.close("s", "answered", "form")
    expect(flow.status).toBe("answered")
    expect(replies).toHaveLength(0)
  })

  test("finds a question by its short ID", () => {
    const { questions } = stub()
    open.push(questions)
    const flow = questions.open("s", "form_0123456789abcdef", [single])
    expect(questions.byShortID(shortID("form_0123456789abcdef"))).toBe(flow)
    expect(`q:${shortID("form_0123456789abcdef")}:t:99`.length).toBeLessThanOrEqual(64)
  })
})

describe("trackForms", () => {
  test("opens question forms and cancels them when the run ends", () => {
    const { questions } = stub()
    open.push(questions)
    trackForms(questions, { type: "form.created", data: { form: { id: "x", sessionID: "s", metadata: { kind: "other" }, fields: [] } } })
    expect(questions.pending("s")).toBeUndefined()
    trackForms(questions, { type: "form.created", data: { form: { id: "f", sessionID: "s", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string", options: [] }] } } })
    const flow = questions.pending("s")!
    expect(flow.formID).toBe("f")
    trackForms(questions, { type: "session.execution.interrupted", data: { sessionID: "s" } })
    expect(flow.status).toBe("cancelled")
    expect(flow.summary()).toContain("Cancelled")
  })
})

describe("parseAction", () => {
  test("parses button actions", () => {
    expect(parseAction("p:2")).toEqual({ type: "pick", option: 2 })
    expect(parseAction("t:0")).toEqual({ type: "toggle", option: 0 })
    expect(parseAction("s")).toEqual({ type: "submit" })
    expect(parseAction("x")).toEqual({ type: "skip" })
    expect(parseAction("p:x")).toBeUndefined()
    expect(parseAction("z")).toBeUndefined()
  })
})
