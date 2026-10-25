import { Link, type Href } from "expo-router"
import type { ReactNode } from "react"
import { Pressable, Text, View } from "react-native"
import { font, radius, space, useTheme } from "@/theme"
import { Icon } from "./art"

/** A rounded group of rows, with an optional caption above and hint below. */
export function Section({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  const { c } = useTheme()
  return (
    <View style={{ gap: space.sm }}>
      {!!title && <Text style={{ color: c.textMuted, fontSize: font.size.caption, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", paddingHorizontal: space.xs }}>{title}</Text>}
      <View style={{ backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: radius.lg, borderCurve: "continuous", overflow: "hidden" }}>{children}</View>
      {!!hint && <Text style={{ color: c.textMuted, fontSize: font.size.small, lineHeight: font.lineHeight.small, paddingHorizontal: space.xs }}>{hint}</Text>}
    </View>
  )
}

/** A label and value. */
export function InfoRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const { c } = useTheme()
  return (
    <View style={{ padding: space.lg, gap: 2, borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border }}>
      <Text style={{ color: c.textMuted, fontSize: font.size.caption }}>{label}</Text>
      <Text selectable style={{ color: c.text, fontSize: font.size.body }}>
        {value}
      </Text>
    </View>
  )
}

/** A row that opens another screen. */
export function LinkRow({ href, emoji, label, detail, last }: { href: Href; emoji: string; label: string; detail?: string; last?: boolean }) {
  const { c } = useTheme()
  return (
    <Link href={href} asChild>
      <Pressable style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, backgroundColor: pressed ? c.surfaceAlt : "transparent", borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border })}>
        <Text style={{ fontSize: 20 }}>{emoji}</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.text, fontSize: font.size.body, fontWeight: "600" }}>{label}</Text>
          {!!detail && (
            <Text numberOfLines={1} style={{ color: c.textMuted, fontSize: font.size.small }}>
              {detail}
            </Text>
          )}
        </View>
        <Icon name="chevron" size={18} color={c.textMuted} />
      </Pressable>
    </Link>
  )
}

/** A full-width tappable row with a single label, e.g. a destructive action. */
export function ActionRow({ label, onPress, tone = "accent", last }: { label: string; onPress: () => void; tone?: "accent" | "danger"; last?: boolean }) {
  const { c } = useTheme()
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ padding: space.lg, backgroundColor: pressed ? c.surfaceAlt : "transparent", borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border })}>
      <Text style={{ color: tone === "danger" ? c.danger : c.accent, fontSize: font.size.body, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  )
}

/** A choice among a few options, like a radio list. */
export function ChoiceRow({ label, detail, selected, onPress, last }: { label: string; detail?: string; selected: boolean; onPress: () => void; last?: boolean }) {
  const { c } = useTheme()
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, backgroundColor: pressed ? c.surfaceAlt : "transparent", borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border })}>
      <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: selected ? c.primary : c.borderStrong, alignItems: "center", justifyContent: "center" }}>
        {selected && <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: c.primary }} />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.text, fontSize: font.size.body, fontWeight: selected ? "700" : "500" }}>{label}</Text>
        {!!detail && <Text style={{ color: c.textMuted, fontSize: font.size.small, lineHeight: font.lineHeight.small }}>{detail}</Text>}
      </View>
    </Pressable>
  )
}

/** An error line under a screen's content. */
export function ErrorText({ error }: { error: string | null }) {
  const { c } = useTheme()
  if (!error) return null
  return (
    <Text selectable style={{ color: c.danger, fontSize: font.size.small, textAlign: "center" }}>
      {error}
    </Text>
  )
}
