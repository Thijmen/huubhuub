import { router } from "expo-router"
import { Pressable, Text, View } from "react-native"
import type { ConversationSummary } from "@server/protocol"
import { relativeTime, t } from "@/lib/i18n"
import { topicOf } from "@/lib/topic"
import { font, space, useTheme } from "@/theme"
import { HuubAvatar, Tile, TypingDots } from "./art"

/**
 * One conversation in a list: its tile, title and time, and below that what was said last, that Huub is
 * typing, that it waits for an answer, or a search snippet. Rows sit in a card (`grouped`) or straight on
 * the background.
 */
export function ConversationRow({
  item,
  snippet,
  onLongPress,
  grouped,
  first,
}: {
  item: ConversationSummary
  snippet?: string | null
  onLongPress?: () => void
  /** Inside a card: the card draws the background, rows get a divider. */
  grouped?: boolean
  /** The first row of a card, without a divider above. */
  first?: boolean
}) {
  const { c } = useTheme()
  const topic = topicOf(item.title, item.id)
  const fresh = Date.now() - item.updatedAt < 60_000
  const status = snippet !== undefined ? "snippet" : item.busy ? "typing" : item.asking ? "asking" : "preview"
  const prefix = item.from === "assistant" ? t("previewHuub") : item.from === "user" ? t("previewYou") : ""

  return (
    <Pressable
      onPress={() => router.push({ pathname: "/c/[id]", params: { id: item.id } })}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingHorizontal: grouped ? 14 : 18,
        paddingVertical: grouped ? 11 : 10,
        backgroundColor: pressed ? c.surfaceAlt : "transparent",
        borderTopWidth: grouped && !first ? 1 : 0,
        borderTopColor: c.border,
      })}
    >
      <Tile emoji={topic.emoji} letter={topic.letter} tint={topic.tint} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontSize: 15.5, fontWeight: "600" }}>
            {topic.title || t("untitled")}
          </Text>
          <Text style={{ fontSize: font.size.caption, color: item.busy || fresh ? c.primaryText : c.textMuted, fontWeight: item.busy || fresh ? "700" : "400", fontVariant: ["tabular-nums"] }}>
            {item.busy ? t("now") : relativeTime(item.updatedAt)}
          </Text>
        </View>
        {status === "typing" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 1 }}>
            <HuubAvatar size={18} />
            <Text numberOfLines={1} style={{ color: c.primaryText, fontSize: font.size.small, fontWeight: "600" }}>
              {t("typing")}
            </Text>
            <TypingDots />
          </View>
        ) : status === "asking" ? (
          <Text numberOfLines={1} style={{ color: c.accent, fontSize: font.size.small, fontWeight: "600", marginTop: 1 }}>
            {t("asking")}
          </Text>
        ) : (
          !!(snippet ?? item.preview) && (
            <Text numberOfLines={1} style={{ color: c.textMuted, fontSize: font.size.small, marginTop: 1 }}>
              {status === "preview" ? prefix : ""}
              {snippet ?? item.preview}
            </Text>
          )
        )}
      </View>
      {status === "asking" && <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: c.primary, marginLeft: 4 }} />}
    </Pressable>
  )
}
