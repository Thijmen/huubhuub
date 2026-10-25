import { Image } from "expo-image"
import { memo, useState } from "react"
import { Pressable, Text, View } from "react-native"
import Animated, { FadeIn } from "react-native-reanimated"
import type { AppMessage, AppTool, ToolKind } from "@server/protocol"
import { assistantText } from "@/lib/chat-state"
import { t, toolEmoji, toolText } from "@/lib/i18n"
import { font, radius, space, useTheme } from "@/theme"
import { HuubAvatar, Icon, Spinner, TypingDots } from "./art"
import { Markdown } from "./markdown"

/** Huub's avatar column: 28 wide, plus the gap to the bubble. */
const GUTTER = 36

export const UserBubble = memo(function UserBubble({ text, images = [], pending }: { text: string; images?: { uri: string | null }[]; pending?: boolean }) {
  const { c } = useTheme()
  return (
    <Animated.View entering={FadeIn.duration(180)} style={{ alignSelf: "flex-end", maxWidth: "80%" }}>
      <View style={{ alignItems: "flex-end", gap: space.xs, opacity: pending ? 0.6 : 1 }}>
        {images.map((img, i) =>
          img.uri ? <Image key={i} source={{ uri: img.uri }} style={{ width: 200, height: 200, borderRadius: radius.lg, borderBottomRightRadius: text ? radius.lg : radius.bubbleTail }} contentFit="cover" /> : null,
        )}
        {!!text && (
          <View
            style={{
              backgroundColor: c.userBubble,
              borderRadius: radius.bubble,
              borderBottomRightRadius: radius.bubbleTail,
              borderCurve: "continuous",
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <Text selectable style={{ color: c.userBubbleText, fontSize: font.size.body, lineHeight: 22 }}>
              {text}
            </Text>
          </View>
        )}
      </View>
    </Animated.View>
  )
})

/** One of Huub's replies, full width, with the avatar at the top of a run of replies. */
export const HuubBubble = memo(function HuubBubble({ message, showAvatar, notes = [] }: { message: Extract<AppMessage, { role: "assistant" }>; showAvatar: boolean; notes?: AppTool[] }) {
  const { c } = useTheme()
  const text = assistantText(message)
  if (!text && !message.error && message.done) return null
  return (
    <Animated.View entering={FadeIn.duration(180)} style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
      <View style={{ width: 28, paddingTop: 2 }}>{showAvatar && <HuubAvatar size={28} />}</View>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          backgroundColor: c.huubBubble,
          borderColor: c.huubBubbleBorder,
          borderWidth: 1,
          borderRadius: radius.bubble,
          borderTopLeftRadius: showAvatar ? radius.bubbleTail : radius.bubble,
          borderCurve: "continuous",
          paddingHorizontal: 14,
          paddingTop: 11,
          paddingBottom: 12,
          gap: space.sm,
          boxShadow: c.shadow,
        }}
      >
        {text ? <Markdown text={text} /> : !message.error && <TypingDots size={7} color={c.primary} />}
        {message.error && (
          <Text selectable style={{ color: c.danger, fontSize: font.size.small, lineHeight: font.lineHeight.small }}>
            ⚠️ {message.error}
          </Text>
        )}
        {notes.map((x) => (
          <NoteCard key={x.id} note={x.note!} />
        ))}
      </View>
    </Animated.View>
  )
})

/** A day divider: "Vandaag", "Gisteren", "zaterdag 24 oktober". */
export function DayLabel({ label }: { label: string }) {
  const { c } = useTheme()
  return (
    <View style={{ alignSelf: "center", backgroundColor: c.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, marginVertical: 2 }}>
      <Text style={{ color: c.textMuted, fontSize: 11.5, fontWeight: "700" }}>{label}</Text>
    </View>
  )
}

/**
 * The tools Huub used for a reply, as small pills under the question. A long run folds into one pill
 * ("3 steps") that opens on tap. Reminders and memories get a card of their own.
 */
export function ToolRun({ tools, live }: { tools: AppTool[]; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const notes = tools.filter((x) => x.note)
  const plain = tools.filter((x) => !x.note)
  const running = plain.filter((x) => x.status === "running")
  const finished = plain.filter((x) => x.status !== "running")
  const fold = finished.length > 2 && !open
  return (
    <View style={{ gap: 6, marginLeft: GUTTER }}>
      {fold ? <FoldedPill tools={finished} onPress={() => setOpen(true)} /> : finished.map((x) => <ToolPill key={x.id} tool={x} />)}
      {running.map((x) => (
        <ToolPill key={x.id} tool={x} live={live} />
      ))}
      {notes.map((x) => (
        <NoteCard key={x.id} note={x.note!} />
      ))}
    </View>
  )
}

function ToolPill({ tool, live }: { tool: AppTool; live?: boolean }) {
  const { c } = useTheme()
  const running = tool.status === "running"
  const showDetail = tool.detail && ["search", "shell", "helper", "skill"].includes(tool.kind)
  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      style={{
        alignSelf: "flex-start",
        maxWidth: "100%",
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        backgroundColor: running ? c.primarySoft : c.surfaceAlt,
        borderRadius: radius.pill,
        paddingLeft: 9,
        paddingRight: 12,
        paddingVertical: 5,
      }}
    >
      {running && live !== false ? (
        <Spinner />
      ) : tool.status === "error" ? (
        <Text style={{ color: c.danger, fontWeight: "800", fontSize: 13 }}>✕</Text>
      ) : (
        <Text style={{ color: c.success, fontWeight: "800", fontSize: 13 }}>✓</Text>
      )}
      <Text numberOfLines={1} style={{ flexShrink: 1, color: running ? c.text : c.textMuted, fontSize: 13, lineHeight: 18 }}>
        {toolEmoji(tool.kind)} {toolText(tool.kind, tool.detail, !running)}
        {running ? "…" : ""}
        {showDetail ? <Text style={{ fontStyle: "italic", color: c.textMuted }}>{`  “${tool.detail}”`}</Text> : null}
      </Text>
    </Animated.View>
  )
}

function FoldedPill({ tools, onPress }: { tools: AppTool[]; onPress: () => void }) {
  const { c } = useTheme()
  const kinds = new Set<ToolKind>(tools.map((x) => x.kind))
  const only = kinds.size === 1 ? tools[0]!.kind : null
  const failed = tools.some((x) => x.status === "error")
  const label = only ? `${toolEmoji(only)} ${toolText(only, "", true)} · ${tools.length}×` : `🧰 ${t("toolsDone", { n: tools.length })}`
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: pressed ? c.border : c.surfaceAlt, borderRadius: radius.pill, paddingLeft: 9, paddingRight: 10, paddingVertical: 5 })}
    >
      <Text style={{ color: failed ? c.danger : c.success, fontWeight: "800", fontSize: 13 }}>{failed ? "!" : "✓"}</Text>
      <Text style={{ color: c.textMuted, fontSize: 13, lineHeight: 18 }}>{label}</Text>
      <Icon name="chevronDown" size={14} color={c.textMuted} />
    </Pressable>
  )
}

function NoteCard({ note }: { note: NonNullable<AppTool["note"]> }) {
  const { c } = useTheme()
  const reminder = note.type === "reminder"
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: reminder ? c.accentSoft : c.primarySoft, borderRadius: 14, borderCurve: "continuous", paddingHorizontal: 11, paddingVertical: 9 }}
    >
      <Text style={{ fontSize: 20 }}>{reminder ? "⏰" : "🧠"}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={{ color: c.text, fontSize: font.size.small, lineHeight: 19, fontWeight: "700" }}>
          {note.text}
        </Text>
        <Text style={{ color: c.textMuted, fontSize: font.size.caption }}>{reminder ? t("reminderSet") : t("memorySaved")}</Text>
      </View>
    </Animated.View>
  )
}

/** Huub is working without a tool running: thinking, or trying again after an error. */
export function WorkingLine({ retry }: { retry: { attempt: number } | null }) {
  const { c } = useTheme()
  return (
    <Animated.View entering={FadeIn.duration(200)} style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
      <View style={{ width: 28, paddingTop: 2 }}>
        <HuubAvatar size={28} />
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          backgroundColor: c.huubBubble,
          borderColor: c.huubBubbleBorder,
          borderWidth: 1,
          borderRadius: radius.bubble,
          borderTopLeftRadius: radius.bubbleTail,
          paddingHorizontal: 14,
          paddingVertical: 12,
          boxShadow: c.shadow,
        }}
      >
        <TypingDots size={7} color={c.primary} />
        {retry && <Text style={{ color: c.textMuted, fontSize: font.size.small }}>{t("retrying", { attempt: retry.attempt })}</Text>}
      </View>
    </Animated.View>
  )
}
