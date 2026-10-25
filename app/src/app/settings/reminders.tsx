import { Stack } from "expo-router"
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native"
import type { ScheduleItem, ScheduleList } from "@server/protocol"
import { ErrorText, Section } from "@/components/settings-ui"
import { dateTime, t } from "@/lib/i18n"
import { useApi } from "@/lib/session"
import { useLoad } from "@/lib/use-load"
import { font, space, useTheme } from "@/theme"

/** Reminders and other scheduled tasks in this person's conversations: pause, run now, delete. */
export default function RemindersScreen() {
  const { c } = useTheme()
  const api = useApi()
  const { data, error, change } = useLoad(api.schedules)

  const replace = (list: ScheduleList, item: ScheduleItem): ScheduleList => ({ ...list, schedules: list.schedules.map((s) => (s.id === item.id ? item : s)) })
  const remove = (s: ScheduleItem) =>
    Alert.alert(t("delete"), t("deleteConfirm", { name: s.name }), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("delete"),
        style: "destructive",
        onPress: () => void change(async () => (await api.deleteSchedule(s.id), { ...data!, schedules: data!.schedules.filter((x) => x.id !== s.id) })),
      },
    ])

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Stack.Screen options={{ title: t("reminders") }} />
      {data && data.schedules.length === 0 && <Text style={{ color: c.textMuted, fontSize: font.size.body, lineHeight: font.lineHeight.body, textAlign: "center", padding: space.xl }}>{t("remindersEmpty")}</Text>}
      {data && data.schedules.length > 0 && (
        <Section hint={t("remindersHint")}>
          {data.schedules.map((s, i) => (
            <View key={s.id} style={{ padding: space.lg, gap: space.sm, borderBottomWidth: i === data.schedules.length - 1 ? 0 : 1, borderBottomColor: c.border }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: c.text, fontSize: font.size.body, fontWeight: "700" }}>
                    {s.type === "command" ? "⚙️ " : "⏰ "}
                    {s.name}
                  </Text>
                  <Text style={{ color: c.textMuted, fontSize: font.size.small }}>{s.description}</Text>
                  <Text style={{ color: s.paused ? c.textMuted : c.primaryText, fontSize: font.size.small, fontWeight: "600" }}>
                    {s.running ? t("runningNow") : s.paused ? t("paused") : s.nextAt ? t("nextRun", { when: dateTime(s.nextAt) }) : "—"}
                  </Text>
                </View>
                <Switch
                  value={!s.paused}
                  onValueChange={(on) => void change(async () => replace(data, await api.setPaused(s.id, !on)))}
                  trackColor={{ true: c.primary, false: c.borderStrong }}
                />
              </View>
              {!!s.prompt && (
                <Text numberOfLines={3} style={{ color: c.text, fontSize: font.size.small, lineHeight: font.lineHeight.small, fontStyle: "italic" }}>
                  “{s.prompt}”
                </Text>
              )}
              <View style={{ flexDirection: "row", gap: space.xl }}>
                <Pressable onPress={() => void change(async () => replace(data, await api.runNow(s.id)))} hitSlop={8} disabled={s.running}>
                  <Text style={{ color: s.running ? c.textMuted : c.accent, fontWeight: "600" }}>{t("runNow")}</Text>
                </Pressable>
                <Pressable onPress={() => remove(s)} hitSlop={8}>
                  <Text style={{ color: c.danger, fontWeight: "600" }}>{t("delete")}</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </Section>
      )}
      <ErrorText error={error} />
    </ScrollView>
  )
}
