import { router, type Href } from "expo-router"
import type { ReactNode } from "react"
import { Pressable, Text, View } from "react-native"
import { font, radius, space, useTheme } from "@/theme"
import { Icon } from "./art"

/** A rounded group of rows, with an optional caption above and hint below. */
export function Section({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  const { c } = useTheme()
  return (
    <View style={{ gap: space.sm }}>
      {!!title && <Text style={{ color: c.textMuted, fontSize: 11.5, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", paddingHorizontal: 10 }}>{title}</Text>}
      <View style={{ backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: radius.card, borderCurve: "continuous", boxShadow: c.shadow }}>
        <View style={{ borderRadius: radius.card - 1, overflow: "hidden" }}>{children}</View>
      </View>
      {!!hint && <Text style={{ color: c.textMuted, fontSize: 13, lineHeight: 18, paddingHorizontal: 10 }}>{hint}</Text>}
    </View>
  )
}

/** A label and value. */
export function InfoRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const { c } = useTheme()
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 13, borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border }}>
      <Text style={{ color: c.textMuted, fontSize: font.size.label }}>{label}</Text>
      <Text selectable numberOfLines={2} style={{ flexShrink: 1, color: c.text, fontSize: font.size.label, fontWeight: "500", textAlign: "right" }}>
        {value}
      </Text>
    </View>
  )
}

/** A row with its emoji on a soft tile that opens another screen (`href`), does something (`onPress`), or shows that it's done. */
export function LinkRow({
  href,
  onPress,
  done,
  emoji,
  label,
  detail,
  tint = 0,
  last,
}: {
  href?: Href
  onPress?: () => void
  done?: boolean
  emoji: string
  label: string
  detail?: string
  tint?: number
  last?: boolean
}) {
  const { c } = useTheme()
  const press = href ? () => router.push(href) : onPress
  return (
    <Pressable
      onPress={press}
      disabled={!press}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: pressed ? c.surfaceAlt : "transparent", borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border })}
    >
      <View style={{ width: 40, height: 40, borderRadius: 13, borderCurve: "continuous", backgroundColor: c.tints[tint % c.tints.length], alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 19 }}>{emoji}</Text>
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: onPress && !done ? c.accent : c.text, fontSize: 15.5, fontWeight: "600" }}>{label}</Text>
        {!!detail && (
          <Text numberOfLines={href ? 1 : 3} style={{ color: c.textMuted, fontSize: 13, lineHeight: 18 }}>
            {detail}
          </Text>
        )}
      </View>
      {done ? <Icon name="check" size={18} color={c.success} /> : href ? <Icon name="chevron" size={16} color={c.textMuted} /> : null}
    </Pressable>
  )
}

/** A full-width tappable row with a single label, e.g. a destructive action. */
export function ActionRow({ label, onPress, tone = "accent", last }: { label: string; onPress: () => void; tone?: "accent" | "danger"; last?: boolean }) {
  const { c } = useTheme()
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ paddingHorizontal: space.lg, paddingVertical: 14, backgroundColor: pressed ? c.surfaceAlt : "transparent", borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border })}>
      <Text style={{ color: tone === "danger" ? c.danger : c.accent, fontSize: font.size.label, fontWeight: "700", textAlign: tone === "danger" ? "center" : "left" }}>{label}</Text>
    </Pressable>
  )
}

/** A choice among a few options, like a radio list. */
export function ChoiceRow({ label, detail, selected, onPress, last }: { label: string; detail?: string; selected: boolean; onPress: () => void; last?: boolean }) {
  const { c } = useTheme()
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 13, backgroundColor: pressed ? c.surfaceAlt : "transparent", borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border })}>
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
