import { describe, expect, test } from "bun:test"
import type { Context } from "grammy"
import type { MessageEntity } from "grammy/types"
import { commandArgs, messageText, withEntities } from "./entities"

const at = (text: string, part: string, from = 0) => ({ offset: text.indexOf(part, from), length: part.length })

describe("withEntities", () => {
  test("keeps the address of a link written as text", () => {
    const text = "Photo by Prasongsom Punyauppa-path on Unsplash"
    const author = "https://unsplash.com/@pune134?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText"
    const photo = "https://unsplash.com/photos/a-bunch-of-toys-that-are-on-a-table-YlRxQQxj6Uo?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText"
    const entities: MessageEntity[] = [
      { type: "text_link", ...at(text, "Prasongsom Punyauppa-path"), url: author },
      { type: "text_link", ...at(text, "Unsplash"), url: photo },
    ]
    expect(withEntities(text, entities)).toBe(`Photo by [Prasongsom Punyauppa-path](${author}) on [Unsplash](${photo})`)
  })

  test("counts offsets in UTF-16, like Telegram", () => {
    const text = "🎉 see docs 👍"
    expect(withEntities(text, [{ type: "text_link", ...at(text, "docs"), url: "https://example.com" }])).toBe("🎉 see [docs](https://example.com) 👍")
  })

  test("ignores plain formatting, also around a link", () => {
    const text = "really important link"
    const entities: MessageEntity[] = [
      { type: "bold", offset: 0, length: text.length },
      { type: "italic", ...at(text, "important") },
      { type: "text_link", ...at(text, "link"), url: "https://example.com/a" },
    ]
    expect(withEntities(text, entities)).toBe("really important [link](https://example.com/a)")
  })

  test("escapes brackets in the label and awkward characters in the address", () => {
    const text = "see [1] "
    expect(withEntities(text, [{ type: "text_link", offset: 0, length: text.length, url: "https://en.wikipedia.org/wiki/Bun_(software) x" }])).toBe(
      "[see \\[1\\]](https://en.wikipedia.org/wiki/Bun_%28software%29%20x) ",
    )
  })

  test("mentions of people without a username link to their ID", () => {
    const text = "ask Sanne"
    const user = { id: 42, is_bot: false, first_name: "Sanne" }
    expect(withEntities(text, [{ type: "text_mention", ...at(text, "Sanne"), user }])).toBe("ask [Sanne](tg://user?id=42)")
  })

  test("keeps inline code and code blocks", () => {
    const text = "run npm i then\nconst a = `x`\nok"
    const entities: MessageEntity[] = [
      { type: "code", ...at(text, "npm i") },
      { type: "pre", ...at(text, "const a = `x`"), language: "ts" },
    ]
    expect(withEntities(text, entities)).toBe("run `npm i` then\n```ts\nconst a = `x`\n```\nok")
    expect(withEntities("use `a`", [{ type: "code", offset: 4, length: 3 }])).toBe("use `` `a` ``")
  })

  test("leaves text without entities alone", () => {
    expect(withEntities("<a href=\"https://x.y\">x</a>", undefined)).toBe("<a href=\"https://x.y\">x</a>")
  })
})

describe("messageText and commandArgs", () => {
  const ctx = (message: object, match = "") => ({ message, match }) as unknown as Context

  test("uses the caption and its entities for media", () => {
    const caption = "from Unsplash"
    const c = ctx({ caption, caption_entities: [{ type: "text_link", ...at(caption, "Unsplash"), url: "https://unsplash.com" }] })
    expect(messageText(c)).toBe("from [Unsplash](https://unsplash.com)")
  })

  test("drops the command but keeps links in its arguments", () => {
    const text = "/new@huub_bot  summarise this article"
    const c = ctx({ text, entities: [{ type: "bot_command", offset: 0, length: 13 }, { type: "text_link", ...at(text, "this article"), url: "https://example.com/post" }] }, "summarise this article")
    expect(commandArgs(c)).toBe("summarise [this article](https://example.com/post)")
  })
})
