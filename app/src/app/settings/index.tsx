import * as Application from "expo-application"
import * as Notifications from "expo-notifications"
import { router, Stack } from "expo-router"
import * as Updates from "expo-updates"
import { useEffect, useState } from "react"
import { Alert, ScrollView, Text, View } from "react-native"
import { HuubAvatar } from "@/components/art"
import { ActionRow, InfoRow, LinkRow, Section } from "@/components/settings-ui"
import { t } from "@/lib/i18n"
import { useSession } from "@/lib/session"
import { font, space, useTheme } from "@/theme"

export default function SettingsScreen() {
  const { c } = useTheme()
  const { session, signOut } = useSession()
  const [push, setPush] = useState<boolean | null>(null)
  const [updateNote, setUpdateNote] = useState<string | null>(null)

  useEffect(() => {
    void Notifications.getPermissionsAsync().then((p) => setPush(p.status === "granted"))
  }, [])

  const checkUpdates = async () => {
    try {
      const result = await Updates.checkForUpdateAsync()
      if (!result.isAvailable) return setUpdateNote(t("upToDate"))
      await Updates.fetchUpdateAsync()
      setUpdateNote(t("updateReady"))
      await Updates.reloadAsync()
    } catch (err) {
      setUpdateNote((err as Error).message)
    }
  }

  const confirmSignOut = () =>
    Alert.alert(t("signOut"), t("signOutConfirm"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("signOut"), style: "destructive", onPress: () => void signOut().then(() => router.replace("/pair")) },
    ])

  if (!session) return null
  const version = `${Application.nativeApplicationVersion ?? "?"} (${Application.nativeBuildVersion ?? "?"})${Updates.updateId ? ` · ${Updates.updateId.slice(0, 8)}` : ""}`

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.xl }}>
      <Stack.Screen options={{ title: t("settings") }} />
      <View style={{ alignItems: "center", gap: space.sm, paddingTop: space.md }}>
        <HuubAvatar size={64} />
        <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: font.size.title }}>{session.me.person.name ?? t("appName")}</Text>
      </View>
      <Section title={t("you")}>
        <LinkRow href="/settings/persona" emoji="🎭" label={t("persona")} detail={t("personaHint")} />
        <LinkRow href="/settings/memory" emoji="🧠" label={t("memory")} detail={t("memoryHint")} />
        <LinkRow href="/settings/reminders" emoji="⏰" label={t("reminders")} detail={t("remindersHint")} />
        <LinkRow href="/settings/spending" emoji="💶" label={t("spending")} last />
      </Section>
      <Section title={t("appName")}>
        <InfoRow label={t("server")} value={session.server.replace(/^https?:\/\//, "")} />
        <InfoRow label={t("device")} value={session.me.device.name ?? "—"} />
        <InfoRow label={t("notifications")} value={push === null ? "…" : push ? t("notificationsOn") : t("notificationsOff")} />
        <InfoRow label={t("appVersion")} value={version} last={!Updates.isEnabled} />
        {Updates.isEnabled && <ActionRow label={t("checkUpdates")} onPress={() => void checkUpdates()} last />}
      </Section>
      {!!updateNote && (
        <Text selectable style={{ color: c.textMuted, fontSize: font.size.small, textAlign: "center" }}>
          {updateNote}
        </Text>
      )}
      <Section>
        <ActionRow label={t("signOut")} tone="danger" onPress={confirmSignOut} last />
      </Section>
    </ScrollView>
  )
}
