import { Lexer, type Token, type Tokens } from "marked"
import { memo, useMemo, type ReactNode } from "react"
import { Linking, ScrollView, Text, View, type TextStyle } from "react-native"
import { font, radius, space, useTheme, type Palette } from "@/theme"

/** Markdown from Huub as native text: headings, lists, code, quotes, links, tables. */
export const Markdown = memo(function Markdown({ text, color }: { text: string; color?: string }) {
  const { c } = useTheme()
  const tokens = useMemo(() => {
    try {
      return new Lexer({ gfm: true }).lex(text)
    } catch {
      return null
    }
  }, [text])
  const base: TextStyle = { color: color ?? c.text, fontSize: font.size.body, lineHeight: font.lineHeight.body }
  if (!tokens) return <Text style={base} selectable>{text}</Text>
  return <View style={{ gap: space.sm }}>{tokens.map((t, i) => block(t, i, c, base))}</View>
})

function block(t: Token, key: number, c: Palette, base: TextStyle): ReactNode {
  switch (t.type) {
    case "space":
    case "hr":
      return t.type === "hr" ? <View key={key} style={{ height: 1, backgroundColor: c.border, marginVertical: space.xs }} /> : null
    case "heading": {
      const h = t as Tokens.Heading
      const size = h.depth <= 1 ? font.size.title : h.depth === 2 ? 19 : font.size.heading
      return (
        <Text key={key} selectable style={{ ...base, fontFamily: font.rounded, fontSize: size, lineHeight: size + 6 }}>
          {inline(h.tokens, c, base)}
        </Text>
      )
    }
    case "paragraph":
      return (
        <Text key={key} selectable style={base}>
          {inline((t as Tokens.Paragraph).tokens, c, base)}
        </Text>
      )
    case "text": {
      const tt = t as Tokens.Text
      return (
        <Text key={key} selectable style={base}>
          {tt.tokens ? inline(tt.tokens, c, base) : tt.text}
        </Text>
      )
    }
    case "list": {
      const l = t as Tokens.List
      const start = typeof l.start === "number" ? l.start : 1
      return (
        <View key={key} style={{ gap: space.xs }}>
          {l.items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row", gap: space.sm }}>
              <Text style={{ ...base, color: c.primaryText, minWidth: l.ordered ? 22 : 12, fontVariant: ["tabular-nums"] }}>
                {item.task ? (item.checked ? "☑" : "☐") : l.ordered ? `${start + i}.` : "•"}
              </Text>
              <View style={{ flex: 1, gap: space.xs }}>{item.tokens.map((child, j) => block(child, j, c, base))}</View>
            </View>
          ))}
        </View>
      )
    }
    case "code": {
      const code = t as Tokens.Code
      return (
        <ScrollView key={key} horizontal style={{ backgroundColor: c.codeBg, borderRadius: radius.md, borderCurve: "continuous" }} contentContainerStyle={{ padding: space.md }}>
          <Text selectable style={{ color: c.codeText, fontFamily: font.mono, fontSize: font.size.code, lineHeight: font.lineHeight.code }}>
            {code.text}
          </Text>
        </ScrollView>
      )
    }
    case "blockquote":
      return (
        <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: c.questionBorder, paddingLeft: space.md, gap: space.xs }}>
          {(t as Tokens.Blockquote).tokens.map((child, j) => block(child, j, c, { ...base, color: c.textMuted }))}
        </View>
      )
    case "table": {
      const table = t as Tokens.Table
      const row = (cells: Tokens.TableCell[], header: boolean, k: number) => (
        <View key={k} style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.border }}>
          {cells.map((cell, i) => (
            <Text key={i} selectable style={{ ...base, flex: 1, padding: space.xs, fontWeight: header ? "700" : "400", fontSize: font.size.small, lineHeight: font.lineHeight.small }}>
              {inline(cell.tokens, c, base)}
            </Text>
          ))}
        </View>
      )
      return (
        <View key={key}>
          {row(table.header, true, -1)}
          {table.rows.map((r, i) => row(r, false, i))}
        </View>
      )
    }
    default:
      return "text" in t && typeof t.text === "string" ? (
        <Text key={key} selectable style={base}>
          {t.text}
        </Text>
      ) : null
  }
}

function inline(tokens: Token[] | undefined, c: Palette, base: TextStyle): ReactNode {
  return tokens?.map((t, i) => {
    switch (t.type) {
      case "strong":
        return (
          <Text key={i} style={{ fontWeight: "700" }}>
            {inline((t as Tokens.Strong).tokens, c, base)}
          </Text>
        )
      case "em":
        return (
          <Text key={i} style={{ fontStyle: "italic" }}>
            {inline((t as Tokens.Em).tokens, c, base)}
          </Text>
        )
      case "del":
        return (
          <Text key={i} style={{ textDecorationLine: "line-through" }}>
            {inline((t as Tokens.Del).tokens, c, base)}
          </Text>
        )
      case "codespan":
        return (
          <Text key={i} style={{ fontFamily: font.mono, fontSize: font.size.code, backgroundColor: c.inlineCodeBg, color: c.inlineCodeText }}>
            {` ${decode((t as Tokens.Codespan).text)} `}
          </Text>
        )
      case "link": {
        const link = t as Tokens.Link
        return (
          <Text key={i} style={{ color: c.accent, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(link.href).catch(() => {})}>
            {inline(link.tokens, c, base)}
          </Text>
        )
      }
      case "image":
        return (
          <Text key={i} style={{ color: c.accent }} onPress={() => void Linking.openURL((t as Tokens.Image).href).catch(() => {})}>
            🖼 {(t as Tokens.Image).text || (t as Tokens.Image).href}
          </Text>
        )
      case "br":
        return "\n"
      case "text": {
        const tt = t as Tokens.Text
        return tt.tokens ? <Text key={i}>{inline(tt.tokens, c, base)}</Text> : decode(tt.text)
      }
      case "escape":
        return (t as Tokens.Escape).text
      default:
        return "text" in t && typeof t.text === "string" ? decode(t.text) : null
    }
  })
}

/** marked escapes HTML entities in text tokens; native text shows them literally. */
function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}
