import * as Clipboard from "expo-clipboard"
import { Lexer, type Token, type Tokens } from "marked"
import { memo, useMemo, useState, type ReactNode } from "react"
import { Linking, Pressable, ScrollView, Text, View, type TextStyle } from "react-native"
import { t as tr } from "@/lib/i18n"
import { font, radius, space, useTheme, type Palette } from "@/theme"
import { Icon } from "./art"

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
      const size = h.depth <= 1 ? 20 : h.depth === 2 ? 18.5 : font.size.heading
      return (
        <Text key={key} selectable style={{ ...base, fontFamily: font.rounded, fontSize: size, lineHeight: size + 6.5 }}>
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
        <View key={key} style={{ gap: 3 }}>
          {l.items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 8 }}>
              {item.task ? (
                <View style={{ width: 16, height: 16, marginTop: 4, borderRadius: 5, borderWidth: 2, borderColor: item.checked ? c.primary : c.borderStrong, backgroundColor: item.checked ? c.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
                  {item.checked && <Icon name="check" size={11} color={c.onPrimary} />}
                </View>
              ) : l.ordered ? (
                <Text style={{ ...base, minWidth: 18, color: c.primaryText, fontFamily: font.rounded, fontVariant: ["tabular-nums"] }}>{start + i}.</Text>
              ) : (
                <View style={{ width: 10, alignItems: "center", paddingTop: 9 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.primary }} />
                </View>
              )}
              <View style={{ flex: 1, gap: space.xs }}>{item.tokens.filter((child) => child.type !== "checkbox").map((child, j) => block(child, j, c, base))}</View>
            </View>
          ))}
        </View>
      )
    }
    case "code":
      return <CodeBlock key={key} code={t as Tokens.Code} />
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

/** A code block with its language (or label) on top and a copy button. */
function CodeBlock({ code }: { code: Tokens.Code }) {
  const { c } = useTheme()
  const [copied, setCopied] = useState(false)
  const copy = () =>
    void Clipboard.setStringAsync(code.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  return (
    <View style={{ backgroundColor: c.codeBg, borderRadius: 12, borderCurve: "continuous", overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: c.codeHeader, paddingLeft: 12, paddingRight: 8, paddingVertical: 5 }}>
        <Text style={{ color: c.codeDim, fontSize: 11.5, fontWeight: "600", letterSpacing: 0.4, textTransform: "uppercase" }}>{code.lang?.split(/\s/)[0] || "code"}</Text>
        <Pressable onPress={copy} hitSlop={8} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name={copied ? "check" : "copy"} size={13} color={c.codeDim} />
          <Text style={{ color: c.codeDim, fontSize: 11.5, fontWeight: "600" }}>{copied ? tr("copied") : tr("copy")}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 9, paddingBottom: 10 }}>
        <Text selectable style={{ color: c.codeText, fontFamily: font.mono, fontSize: 12.5, lineHeight: 19 }}>
          {code.text}
        </Text>
      </ScrollView>
    </View>
  )
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
          <Text key={i} style={{ fontFamily: font.mono, fontSize: font.size.code, backgroundColor: c.inlineCodeBg, color: c.inlineCodeText, borderRadius: radius.xs }}>
            {` ${decode((t as Tokens.Codespan).text)} `}
          </Text>
        )
      case "link": {
        const link = t as Tokens.Link
        return (
          <Text key={i} style={{ color: c.accent, textDecorationLine: "underline", textDecorationColor: c.accent }} onPress={() => void Linking.openURL(link.href).catch(() => {})}>
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
