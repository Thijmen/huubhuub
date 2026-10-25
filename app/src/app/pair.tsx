import { CameraView, useCameraPermissions } from "expo-camera"
import { router, useLocalSearchParams } from "expo-router"
import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import { HuubAvatar, Icon } from "@/components/art"
import { t } from "@/lib/i18n"
import { parseInvite, type Invite } from "@/lib/invite"
import { useSession } from "@/lib/session"
import { font, radius, space, useTheme } from "@/theme"

/**
 * Sign in with an invite: scan its QR code, paste its link, or arrive here from the invite page
 * (`huubhuub://pair?server=…&code=…`).
 */
export default function PairScreen() {
  const { c } = useTheme()
  const { signIn } = useSession()
  const params = useLocalSearchParams<{ server?: string; code?: string }>()
  const [permission, requestPermission] = useCameraPermissions()
  const [pasting, setPasting] = useState(false)
  const [link, setLink] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const handled = useRef<string | null>(null)

  const use = async (invite: Invite | null) => {
    if (!invite) return setError(t("pairBadLink"))
    if (busy || handled.current === invite.code) return
    handled.current = invite.code
    setBusy(true)
    setError(null)
    try {
      await signIn(invite.server, invite.code)
      router.replace("/")
    } catch (err) {
      setError((err as Error).message)
      handled.current = null
    } finally {
      setBusy(false)
    }
  }

  // Opened from the invite page.
  useEffect(() => {
    if (params.server && params.code) void use(parseInvite(`huubhuub://pair?server=${encodeURIComponent(params.server)}&code=${encodeURIComponent(params.code)}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.server, params.code])

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: space.xxl, paddingTop: space.huge * 1.5, gap: space.xl }} keyboardShouldPersistTaps="handled">
      <View style={{ alignItems: "center", gap: space.md }}>
        <HuubAvatar size={84} />
        <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: font.size.display, lineHeight: font.lineHeight.display }}>{t("appName")}</Text>
        <Text style={{ color: c.textMuted, fontSize: font.size.body, lineHeight: font.lineHeight.body, textAlign: "center" }}>{t("pairIntro")}</Text>
      </View>

      {busy ? (
        <View style={{ alignItems: "center", gap: space.md, padding: space.xxl }}>
          <ActivityIndicator color={c.primary} size="large" />
          <Text style={{ color: c.textMuted }}>{t("pairBusy")}</Text>
        </View>
      ) : pasting ? (
        <View style={{ gap: space.md }}>
          <TextInput
            value={link}
            onChangeText={setLink}
            placeholder={t("pairPastePlaceholder")}
            placeholderTextColor={c.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onSubmitEditing={() => void use(parseInvite(link))}
            style={{ color: c.text, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: radius.md, padding: space.lg, fontSize: font.size.body }}
          />
          <PrimaryButton label={t("pairPasteSubmit")} onPress={() => void use(parseInvite(link))} disabled={!link.trim()} />
        </View>
      ) : (
        <View style={{ aspectRatio: 1, borderRadius: radius.xl, borderCurve: "continuous", overflow: "hidden", backgroundColor: c.surfaceAlt, borderColor: c.primary, borderWidth: 3 }}>
          {permission?.granted ? (
            <>
              <CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => void use(parseInvite(data))} />
              <Text style={{ position: "absolute", bottom: space.lg, alignSelf: "center", color: "#fff", fontWeight: "700", textShadowColor: "rgba(0,0,0,.6)", textShadowRadius: 6 }}>
                {t("pairScanHint")}
              </Text>
            </>
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.lg, padding: space.xxl }}>
              <Text style={{ color: c.text, fontSize: font.size.body, textAlign: "center", lineHeight: font.lineHeight.body }}>{t("pairCameraAsk")}</Text>
              <PrimaryButton label={t("pairCameraAllow")} onPress={() => void requestPermission()} />
            </View>
          )}
        </View>
      )}

      {!!error && (
        <Text selectable style={{ color: c.danger, fontSize: font.size.label, textAlign: "center" }}>
          {error}
        </Text>
      )}

      {!busy && (
        <Pressable onPress={() => setPasting((p) => !p)} style={{ flexDirection: "row", alignSelf: "center", alignItems: "center", gap: space.sm, padding: space.sm }}>
          <Icon name="link" size={20} color={c.accent} />
          <Text style={{ color: c.accent, fontSize: font.size.label, fontWeight: "700" }}>{pasting ? t("pairScanHint") : t("pairPasteInstead")}</Text>
        </Pressable>
      )}
    </ScrollView>
  )
}

function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { c } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        backgroundColor: c.primary,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        paddingVertical: space.lg,
        paddingHorizontal: space.xxl,
        alignItems: "center",
      })}
    >
      <Text style={{ color: c.onPrimary, fontFamily: font.rounded, fontSize: font.size.heading }}>{label}</Text>
    </Pressable>
  )
}
