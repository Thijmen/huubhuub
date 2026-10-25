import * as Application from "expo-application"
import * as Notifications from "expo-notifications"
import { router, Stack } from "expo-router"
import * as Updates from "expo-updates"
import { useEffect, useState, type ReactNode } from "react"
import { Alert, Pressable, ScrollView, Text, View } from "react-native"
import { HuubAvatar } from "@/components/art"
import { t } from "@/lib/i18n"
import { useSession } from "@/lib/session"
import { font, radius, space, useTheme } from "@/theme"

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
      {
        text: t("signOut"),
        style: "destructive",
        onPress: () => {
          void signOut().then(() => router.replace("/pair"))
        },
      },
    ])

  if (!session) return null
  const version = `${Application.nativeApplicationVersion ?? "?"} (${Application.nativeBuildVersion ?? "?"})${Updates.updateId ? ` · ${Updates.updateId.slice(0, 8)}` : ""}`

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Stack.Screen options={{ title: t("settings") }} />
      <View style={{ alignItems: "center", gap: space.sm, paddingVertical: space.lg }}>
        <HuubAvatar size={64} />
        <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: font.size.title }}>{session.me.person.name ?? t("appName")}</Text>
      </View>
      <Section>
        <Row label={t("server")} value={session.server.replace(/^https?:\/\//, "")} />
        <Row label={t("device")} value={session.me.device.name ?? "—"} />
        <Row label={t("notifications")} value={push === null ? "…" : push ? t("notificationsOn") : t("notificationsOff")} />
        <Row label={t("appVersion")} value={version} last />
      </Section>
      {Updates.isEnabled && (
        <Section>
          <Pressable onPress={() => void checkUpdates()} style={{ padding: space.lg, gap: space.xs }}>
            <Text style={{ color: c.accent, fontSize: font.size.body, fontWeight: "600" }}>{t("checkUpdates")}</Text>
            {!!updateNote && (
              <Text selectable style={{ color: c.textMuted, fontSize: font.size.small }}>
                {updateNote}
              </Text>
            )}
          </Pressable>
        </Section>
      )}
      <Section>
        <Pressable onPress={confirmSignOut} style={{ padding: space.lg }}>
          <Text style={{ color: c.danger, fontSize: font.size.body, fontWeight: "600" }}>{t("signOut")}</Text>
        </Pressable>
      </Section>
    </ScrollView>
  )
}

function Section({ children }: { children: ReactNode }) {
  const { c } = useTheme()
  return <View style={{ backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: radius.lg, borderCurve: "continuous", overflow: "hidden" }}>{children}</View>
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
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
