import { Image } from "expo-image"
import { memo, useEffect } from "react"
import { Text, View } from "react-native"
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated"
import type { AppMessage, ToolKind } from "@server/protocol"
import { assistantText } from "@/lib/chat-state"
import { t, toolLabel } from "@/lib/i18n"
import { font, radius, space, useTheme } from "@/theme"
import { HuubAvatar } from "./art"
import { Markdown } from "./markdown"

export const UserBubble = memo(function UserBubble({ text, images = [], pending }: { text: string; images?: { uri: string | null }[]; pending?: boolean }) {
  const { c } = useTheme()
  return (
    <Animated.View entering={FadeIn.duration(180)} style={{ alignSelf: "flex-end", maxWidth: "85%", gap: space.xs, opacity: pending ? 0.6 : 1 }}>
      {images.map((img, i) =>
        img.uri ? <Image key={i} source={{ uri: img.uri }} style={{ width: 200, height: 200, borderRadius: radius.lg }} contentFit="cover" /> : null,
      )}
      {!!text && (
        <View
          style={{
            backgroundColor: c.userBubble,
            borderRadius: radius.bubble,
            borderBottomRightRadius: radius.bubbleTail,
            borderCurve: "continuous",
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
          }}
        >
          <Text selectable style={{ color: c.userBubbleText, fontSize: font.size.body, lineHeight: font.lineHeight.body }}>
            {text}
          </Text>
        </View>
      )}
    </Animated.View>
  )
})

export const HuubBubble = memo(function HuubBubble({ message, showAvatar }: { message: Extract<AppMessage, { role: "assistant" }>; showAvatar: boolean }) {
  const { c } = useTheme()
  const text = assistantText(message)
  if (!text && !message.error && message.done) return null
  return (
    <Animated.View entering={FadeIn.duration(180)} style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm, maxWidth: "92%" }}>
      <View style={{ width: 28 }}>{showAvatar && <HuubAvatar size={28} />}</View>
      <View
        style={{
          flexShrink: 1,
          backgroundColor: c.huubBubble,
          borderColor: c.huubBubbleBorder,
          borderWidth: 1,
          borderRadius: radius.bubble,
          borderBottomLeftRadius: radius.bubbleTail,
          borderCurve: "continuous",
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          gap: space.sm,
        }}
      >
        {text ? <Markdown text={text} /> : !message.error && <Dots />}
        {message.error && (
          <Text selectable style={{ color: c.danger, fontSize: font.size.small, lineHeight: font.lineHeight.small }}>
            ⚠️ {message.error}
          </Text>
        )}
      </View>
    </Animated.View>
  )
})

/** What Huub is doing while it works: a tool's label, or "Thinking". */
export function WorkingLine({ activity, retry }: { activity: { kind: ToolKind; detail: string } | null; retry: { attempt: number } | null }) {
  const { c } = useTheme()
  const label = retry ? t("retrying", { attempt: retry.attempt }) : activity ? toolLabel(activity.kind, activity.detail) : `✻ ${t("thinking")}`
  return (
    <Animated.View entering={FadeIn.duration(200)} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: 36 }}>
      <Text style={{ color: c.primaryText, fontSize: font.size.small, lineHeight: font.lineHeight.small, fontWeight: "600" }} numberOfLines={1}>
        {label}
      </Text>
      <Dots small />
    </Animated.View>
  )
}

function Dots({ small }: { small?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 4, paddingVertical: small ? 0 : 6 }}>
      {[0, 1, 2].map((i) => (
        <Dot key={i} delay={i * 160} size={small ? 5 : 7} />
      ))}
    </View>
  )
}

function Dot({ delay, size }: { delay: number; size: number }) {
  const { c } = useTheme()
  const opacity = useSharedValue(0.3)
  useEffect(() => {
    opacity.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 380 }), withTiming(0.3, { duration: 380 })), -1))
  }, [delay, opacity])
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }))
  return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.primary }, style]} />
}
