import * as Haptics from "expo-haptics"
import { useState } from "react"
import { Pressable, TextInput, View } from "react-native"
import { t } from "@/lib/i18n"
import { font, radius, space, useTheme } from "@/theme"
import { Icon } from "./art"

/**
 * Where you type. While Huub works and the field is empty, the button stops the reply; typing a message
 * while it works queues it.
 */
export function Composer({ busy, onSend, onStop, autoFocus }: { busy: boolean; onSend: (text: string) => Promise<void>; onStop: () => void; autoFocus?: boolean }) {
  const { c } = useTheme()
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const showStop = busy && !text.trim()

  const press = async () => {
    if (showStop) {
      if (process.env.EXPO_OS === "ios") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      return onStop()
    }
    const value = text.trim()
    if (!value || sending) return
    setSending(true)
    setText("")
    try {
      await onSend(value)
    } catch {
      setText(value)
    } finally {
      setSending(false)
    }
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.sm, backgroundColor: c.bg }}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={t("composerPlaceholder")}
        placeholderTextColor={c.textMuted}
        multiline
        autoFocus={autoFocus}
        style={{
          flex: 1,
          maxHeight: 160,
          minHeight: 46,
          color: c.text,
          backgroundColor: c.surface,
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: radius.xl,
          borderCurve: "continuous",
          paddingHorizontal: space.lg,
          paddingTop: 12,
          paddingBottom: 12,
          fontSize: font.size.body,
          lineHeight: 21,
        }}
      />
      <Pressable
        onPress={() => void press()}
        disabled={!showStop && (!text.trim() || sending)}
        accessibilityLabel={showStop ? "Stop" : "Send"}
        style={({ pressed }) => ({
          width: 46,
          height: 46,
          borderRadius: 23,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: showStop ? c.text : text.trim() ? c.primary : c.surfaceAlt,
          opacity: pressed ? 0.8 : 1,
        })}
      >
        <Icon name={showStop ? "stop" : "send"} size={22} color={showStop ? c.bg : text.trim() ? c.onPrimary : c.textMuted} />
      </Pressable>
    </View>
  )
}
