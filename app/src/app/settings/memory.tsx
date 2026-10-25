import { Stack } from "expo-router"
import { useState } from "react"
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import type { MemoryMode } from "@server/protocol"
import { Icon } from "@/components/art"
import { ActionRow, ChoiceRow, ErrorText, Section } from "@/components/settings-ui"
import { t, type Key } from "@/lib/i18n"
import { useApi } from "@/lib/session"
import { useLoad } from "@/lib/use-load"
import { font, radius, space, useTheme } from "@/theme"

const MODES: MemoryMode[] = ["off", "explicit", "auto"]

/** When Huub may remember things, and what it remembers. */
export default function MemoryScreen() {
  const { c } = useTheme()
  const api = useApi()
  const { data, error, change } = useLoad(api.memory)
  const [draft, setDraft] = useState("")

  const add = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    await change(() => api.remember(text))
  }

  const forgetAll = () =>
    Alert.alert(t("memoryForgetAll"), t("memoryForgetAllConfirm", { n: data?.memories.length ?? 0 }), [
      { text: t("cancel"), style: "cancel" },
      { text: t("memoryForgetAll"), style: "destructive", onPress: () => void change(api.forgetAll) },
    ])

  const label = (mode: MemoryMode) => t(`memoryMode_${mode}` as Key)
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.xl }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: t("memory") }} />
      {data && (
        <>
          <Section hint={t(`memoryHelp_${data.effectiveMode}` as Key)}>
            <ChoiceRow label={`${label("default" as MemoryMode)} (${label(data.defaultMode)})`} selected={data.mode === null} onPress={() => void change(() => api.setMemoryMode(null))} />
            {MODES.map((m, i) => (
              <ChoiceRow key={m} label={label(m)} selected={data.mode === m} onPress={() => void change(() => api.setMemoryMode(m))} last={i === MODES.length - 1} />
            ))}
          </Section>

          <View style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: space.xs }}>
              <Text style={{ color: c.textMuted, fontSize: font.size.caption, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" }}>{t("memory")}</Text>
              <Text style={{ color: c.textMuted, fontSize: font.size.caption, fontVariant: ["tabular-nums"] }}>{t("memoryCount", { n: data.memories.length, max: data.max })}</Text>
            </View>
            <Section>
              {data.memories.length === 0 ? (
                <Text style={{ color: c.textMuted, padding: space.lg, fontSize: font.size.body }}>{t("memoryEmpty")}</Text>
              ) : (
                data.memories.map((m, i) => (
                  <View key={m.id} style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, borderBottomWidth: i === data.memories.length - 1 ? 0 : 1, borderBottomColor: c.border }}>
                    <Text selectable style={{ flex: 1, color: c.text, fontSize: font.size.body, lineHeight: font.lineHeight.body }}>
                      {m.text}
                    </Text>
                    <Pressable onPress={() => void change(() => api.forget(m.id))} hitSlop={10} accessibilityLabel={t("forget")}>
                      <Icon name="close" size={18} color={c.textMuted} />
                    </Pressable>
                  </View>
                ))
              )}
            </Section>
          </View>

          <View style={{ flexDirection: "row", gap: space.sm }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={t("memoryAdd")}
              placeholderTextColor={c.textMuted}
              maxLength={500}
              onSubmitEditing={() => void add()}
              returnKeyType="done"
              style={{ flex: 1, color: c.text, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md, fontSize: font.size.body }}
            />
            <Pressable
              onPress={() => void add()}
              disabled={!draft.trim()}
              style={{ width: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: draft.trim() ? c.primary : c.surfaceAlt }}
            >
              <Icon name="check" size={22} color={draft.trim() ? c.onPrimary : c.textMuted} />
            </Pressable>
          </View>

          {data.memories.length > 0 && (
            <Section>
              <ActionRow label={t("memoryForgetAll")} tone="danger" onPress={forgetAll} last />
            </Section>
          )}
        </>
      )}
      <ErrorText error={error} />
    </ScrollView>
  )
}
