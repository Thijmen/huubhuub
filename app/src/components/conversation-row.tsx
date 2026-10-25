import { Link } from "expo-router"
import { Pressable, Text, View } from "react-native"
import Animated, { FadeIn } from "react-native-reanimated"
import type { ConversationSummary } from "@server/protocol"
import { relativeTime, t } from "@/lib/i18n"
import { font, radius, space, useTheme } from "@/theme"
import { Icon } from "./art"

/** One conversation in a list: title, time, and either "typing", a search snippet, or the last message. */
export function ConversationRow({ item, snippet, onLongPress }: { item: ConversationSummary; snippet?: string | null; onLongPress?: () => void }) {
  const { c } = useTheme()
  const preview = snippet ?? item.preview
  return (
    <Link href={{ pathname: "/c/[id]", params: { id: item.id } }} asChild>
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={350}
        style={({ pressed }) => ({
          backgroundColor: pressed ? c.surfaceAlt : c.surface,
          borderColor: item.pinned ? c.questionBorder : c.border,
          borderWidth: 1,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          padding: space.lg,
          gap: space.xs,
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {item.pinned && <Icon name="pin" size={14} color={c.primary} />}
          <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontFamily: font.roundedSemi, fontSize: font.size.heading, lineHeight: font.lineHeight.heading }}>
            {item.title || t("untitled")}
          </Text>
          <Text style={{ color: c.textMuted, fontSize: font.size.caption, fontVariant: ["tabular-nums"] }}>{relativeTime(item.updatedAt)}</Text>
        </View>
        {item.busy && snippet === undefined ? (
          <Animated.Text entering={FadeIn} style={{ color: c.primaryText, fontSize: font.size.small, lineHeight: font.lineHeight.small, fontWeight: "600" }}>
            {t("typing")}
          </Animated.Text>
        ) : (
          !!preview && (
            <Text numberOfLines={2} style={{ color: c.textMuted, fontSize: font.size.small, lineHeight: font.lineHeight.small }}>
              {preview}
            </Text>
          )
        )}
      </Pressable>
    </Link>
  )
}
