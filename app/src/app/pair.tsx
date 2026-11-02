import { CameraView, useCameraPermissions } from "expo-camera"
import { router, useLocalSearchParams } from "expo-router"
import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Halo, Icon } from "@/components/art"
import { t } from "@/lib/i18n"
import { parseInvite, type Invite } from "@/lib/invite"
import { useSession } from "@/lib/session"
import { font, space, useTheme } from "@/theme"

const FINDER = 264

/**
 * Sign in with an invite: scan its QR code, paste its link, or arrive here from the invite page
 * (`huubhuub://pair?server=…&code=…`).
 */
export default function PairScreen() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const { signIn } = useSession()
  const params = useLocalSearchParams<{ server?: string; code?: string }>()
  const [permission, requestPermission] = useCameraPermissions()
  const [pasting, setPasting] = useState(false)
  const [torch, setTorch] = useState(false)
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
    <ScrollView
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={{ flexGrow: 1, alignItems: "center", paddingHorizontal: space.xxl, paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.sm }}
      keyboardShouldPersistTaps="handled"
    >
      <Halo size={84} />
      <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: 26, lineHeight: 32, marginTop: 14, textAlign: "center" }}>{t("pairHello")}</Text>
      <Text style={{ color: c.textMuted, fontSize: font.size.label, lineHeight: 22, marginTop: 6, maxWidth: 280, textAlign: "center" }}>{t("pairIntro")}</Text>

      {busy ? (
        <View style={{ width: FINDER, height: FINDER, marginTop: 20, alignItems: "center", justifyContent: "center", gap: space.md }}>
          <ActivityIndicator color={c.primary} size="large" />
          <Text style={{ color: c.textMuted }}>{t("pairBusy")}</Text>
        </View>
      ) : pasting ? (
        <View style={{ width: "100%", marginTop: 20, gap: space.md }}>
          <TextInput
            value={link}
            onChangeText={setLink}
            placeholder={t("pairPastePlaceholder")}
            placeholderTextColor={c.textMuted}
            cursorColor={c.primary}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onSubmitEditing={() => void use(parseInvite(link))}
            style={{ color: c.text, backgroundColor: c.surface, borderColor: c.borderStrong, borderWidth: 1.5, borderRadius: 18, paddingHorizontal: space.lg, height: 52, fontSize: font.size.body }}
          />
          <Pressable
            onPress={() => void use(parseInvite(link))}
            disabled={!link.trim()}
            style={({ pressed }) => ({ height: 52, borderRadius: 18, backgroundColor: c.primary, opacity: !link.trim() ? 0.4 : pressed ? 0.85 : 1, alignItems: "center", justifyContent: "center" })}
          >
            <Text style={{ color: c.onPrimary, fontFamily: font.rounded, fontSize: font.size.body }}>{t("pairPasteSubmit")}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ width: FINDER, height: FINDER, marginTop: 20, borderRadius: 30, borderCurve: "continuous", overflow: "hidden", backgroundColor: "#1C1F2B" }}>
          {permission?.granted ? (
            <>
              <CameraView style={{ flex: 1 }} enableTorch={torch} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => void use(parseInvite(data))} />
              <ScanLine />
              <Pressable
                onPress={() => setTorch((on) => !on)}
                hitSlop={8}
                accessibilityLabel="Torch"
                style={{ position: "absolute", top: 14, right: 14, width: 34, height: 34, borderRadius: 17, backgroundColor: torch ? c.primary : "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" }}
              >
                <Icon name="torch" size={17} color="#fff" />
              </Pressable>
              <View style={{ position: "absolute", bottom: 14, alignSelf: "center", backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 }}>
                <Text style={{ color: "#fff", fontSize: 12 }}>{t("pairScanHint")}</Text>
              </View>
            </>
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.lg, padding: space.xxl }}>
              <Text style={{ color: "#F5EDE4", fontSize: font.size.label, textAlign: "center", lineHeight: 21 }}>{t("pairCameraAsk")}</Text>
              <Pressable onPress={() => void requestPermission()} style={({ pressed }) => ({ backgroundColor: c.primary, opacity: pressed ? 0.85 : 1, borderRadius: 16, paddingHorizontal: space.xl, paddingVertical: 12 })}>
                <Text style={{ color: c.onPrimary, fontFamily: font.rounded, fontSize: font.size.label }}>{t("pairCameraAllow")}</Text>
              </Pressable>
            </View>
          )}
          <Corners color={c.primary} />
        </View>
      )}

      {!!error && (
        <Text selectable style={{ color: c.danger, fontSize: font.size.small, textAlign: "center", marginTop: space.md }}>
          {error}
        </Text>
      )}
      {!pasting && !busy && <Text style={{ color: c.textMuted, fontSize: 13.5, lineHeight: 20, marginTop: 14, maxWidth: 290, textAlign: "center" }}>{t("pairHelp")}</Text>}

      <View style={{ flex: 1, minHeight: space.xl }} />
      {!busy && (
        <Pressable
          onPress={() => setPasting((p) => !p)}
          style={({ pressed }) => ({
            width: "100%",
            height: 52,
            borderRadius: 18,
            borderCurve: "continuous",
            borderWidth: 1.5,
            borderColor: c.borderStrong,
            backgroundColor: pressed ? c.surfaceAlt : c.surface,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
          })}
        >
          <Icon name={pasting ? "camera" : "link"} size={20} color={c.primaryText} />
          <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: font.size.body }}>{pasting ? t("pairScanInstead") : t("pairPasteInstead")}</Text>
        </Pressable>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12 }}>
        <Icon name="lock" size={14} color={c.textMuted} />
        <Text style={{ color: c.textMuted, fontSize: font.size.caption }}>{t("pairSafe")}</Text>
      </View>
    </ScrollView>
  )
}

/** Orange brackets in the viewfinder's corners. */
function Corners({ color }: { color: string }) {
  const size = 44
  const inset = 22
  const base = { position: "absolute" as const, width: size, height: size, borderColor: color, borderWidth: 4 }
  return (
    <>
      <View pointerEvents="none" style={{ ...base, top: inset, left: inset, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 16 }} />
      <View pointerEvents="none" style={{ ...base, top: inset, right: inset, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 16 }} />
      <View pointerEvents="none" style={{ ...base, bottom: inset, left: inset, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 16 }} />
      <View pointerEvents="none" style={{ ...base, bottom: inset, right: inset, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 16 }} />
    </>
  )
}

/** A glowing line that sweeps up and down while the camera looks for a code. */
function ScanLine() {
  const { c } = useTheme()
  const p = useSharedValue(0)
  useEffect(() => {
    p.value = withRepeat(withTiming(1, { duration: 1300, easing: Easing.inOut(Easing.quad) }), -1, true)
  }, [p])
  const style = useAnimatedStyle(() => ({ top: FINDER * (0.28 + 0.44 * p.value) }))
  return <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 34, right: 34, height: 3, borderRadius: 3, backgroundColor: c.primary, boxShadow: "0px 0px 18px 4px rgba(232, 93, 4, 0.55)" }, style]} />
}
