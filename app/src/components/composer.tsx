import { AudioQuality, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState, type RecordingOptions } from "expo-audio"
import * as Haptics from "expo-haptics"
import { Image } from "expo-image"
import { useEffect, useImperativeHandle, useRef, useState, type ComponentRef, type Ref } from "react"
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import Animated, { Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated"
import { ApiError } from "@/lib/api"
import { t } from "@/lib/i18n"
import { PermissionError, pickPhoto, readBase64, type Photo } from "@/lib/media"
import { font, radius, space, useTheme } from "@/theme"
import { Icon } from "./art"

const MAX_PHOTOS = 4
const BARS = 34

/** AAC in MP4, mono, 16 kHz: small uploads, and the server turns it into what Amazon Transcribe takes. */
const VOICE: RecordingOptions = {
  extension: ".m4a",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 48000,
  isMeteringEnabled: true,
  android: { outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.HIGH },
  web: {},
}

export interface ComposerHandle {
  focus: () => void
  /** Put text in the field, e.g. from a suggestion, and focus it. */
  fill: (text: string) => void
}

interface Props {
  busy: boolean
  onSend: (text: string, photos: Photo[]) => Promise<void>
  onStop: () => void
  /** Turn a voice note into text; absent when the server can't. */
  onTranscribe?: (audio: string, mime: string) => Promise<string>
  autoFocus?: boolean
  ref?: Ref<ComposerHandle>
}

/**
 * Where you write, talk or add photos. While Huub works and the composer is empty, the button stops the
 * reply; a message sent while it works is queued.
 */
export function Composer({ busy, onSend, onStop, onTranscribe, autoFocus, ref }: Props) {
  const { c } = useTheme()
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const [text, setText] = useState("")
  const [photos, setPhotos] = useState<Photo[]>([])
  const [sending, setSending] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorder = useAudioRecorder(VOICE)
  const recording = useAudioRecorderState(recorder, 100)
  const empty = !text.trim() && !photos.length
  const mode = recording.isRecording ? "recording" : transcribing ? "transcribing" : busy && empty ? "stop" : "send"

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    fill: (value: string) => {
      setText(value)
      input.current?.focus()
    },
  }))

  const send = async (value: string, withPhotos: Photo[]) => {
    setSending(true)
    setText("")
    setPhotos([])
    try {
      await onSend(value, withPhotos)
    } catch {
      setText(value)
      setPhotos(withPhotos)
    } finally {
      setSending(false)
    }
  }

  const addPhoto = () => {
    const pick = (source: "camera" | "library") =>
      pickPhoto(source)
        .then((p) => p && setPhotos((list) => [...list, p].slice(0, MAX_PHOTOS)))
        .catch((err) => Alert.alert(t("appName"), err instanceof PermissionError ? t("photoDenied") : (err as Error).message))
    Alert.alert(t("appName"), undefined, [
      { text: t("photoTake"), onPress: () => void pick("camera") },
      { text: t("photoChoose"), onPress: () => void pick("library") },
      { text: t("cancel"), style: "cancel" },
    ])
  }

  const startRecording = async () => {
    const permission = await requestRecordingPermissionsAsync()
    if (!permission.granted) return Alert.alert(t("appName"), t("micDenied"))
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
    await recorder.prepareToRecordAsync()
    recorder.record()
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
  }

  const finishRecording = async (keep: boolean) => {
    await recorder.stop()
    await setAudioModeAsync({ allowsRecording: false }).catch(() => {})
    const uri = recorder.uri
    if (!keep || !uri || !onTranscribe) return
    setTranscribing(true)
    try {
      const said = await onTranscribe(await readBase64(uri), "audio/mp4")
      await send(said, [])
    } catch (err) {
      Alert.alert(t("appName"), err instanceof ApiError && err.status === 422 ? t("noSpeech") : (err as Error).message)
    } finally {
      setTranscribing(false)
    }
  }

  const press = () => {
    if (mode === "stop") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {})
      return onStop()
    }
    if (mode === "send" && !empty && !sending) void send(text.trim(), photos)
  }

  if (mode === "recording" || mode === "transcribing") {
    return (
      <View style={{ backgroundColor: c.bg, paddingTop: space.sm, paddingBottom: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 14, paddingRight: 10 }}>
          <View style={{ flex: 1, minWidth: 0, height: 48, borderRadius: 24, backgroundColor: c.surface, borderWidth: 1, borderColor: c.borderStrong, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 6, paddingRight: 14, overflow: "hidden" }}>
            {mode === "recording" ? (
              <>
                <Pressable onPress={() => void finishRecording(false)} hitSlop={8} accessibilityLabel={t("cancel")} style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" }}>
                  <Icon name="close" size={18} color={c.textMuted} />
                </Pressable>
                <Blink color={c.recording} />
                <Text style={{ color: c.text, fontFamily: font.mono, fontWeight: "600", fontSize: 14 }}>{clock(recording.durationMillis)}</Text>
                <Waveform level={recording.metering} color={c.primary} />
              </>
            ) : (
              <>
                <View style={{ width: 8 }} />
                <ActivityIndicator color={c.primary} size="small" />
                <Text numberOfLines={1} style={{ flex: 1, color: c.primaryText, fontSize: font.size.small, fontWeight: "600" }}>
                  {t("transcribing")}
                </Text>
              </>
            )}
          </View>
          <Pressable onPress={() => void finishRecording(true)} disabled={mode === "transcribing"} accessibilityLabel={t("recording")} style={{ width: 56, height: 56, alignItems: "center", justifyContent: "center" }}>
            {mode === "recording" && <Pulse color={c.primary} />}
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: c.primary, alignItems: "center", justifyContent: "center", opacity: mode === "transcribing" ? 0.5 : 1 }}>
              <Icon name={mode === "recording" ? "send" : "mic"} size={26} color={c.onPrimary} />
            </View>
          </Pressable>
        </View>
        {mode === "recording" && <Text style={{ color: c.textMuted, fontSize: 12.5, textAlign: "center", paddingTop: 4 }}>{t("recordHint")}</Text>}
      </View>
    )
  }

  return (
    <View style={{ gap: space.sm, paddingHorizontal: 10, paddingTop: space.sm, paddingBottom: 6, backgroundColor: c.bg }}>
      {photos.length > 0 && (
        <ScrollView horizontal contentContainerStyle={{ gap: space.sm, paddingHorizontal: 2 }} keyboardShouldPersistTaps="handled">
          {photos.map((p, i) => (
            <Animated.View key={p.uri} entering={FadeIn} exiting={FadeOut}>
              <Image source={{ uri: p.uri }} style={{ width: 72, height: 72, borderRadius: radius.md }} contentFit="cover" />
              <Pressable
                onPress={() => setPhotos((list) => list.filter((_, j) => j !== i))}
                hitSlop={8}
                style={{ position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: "rgba(0,0,0,.6)", alignItems: "center", justifyContent: "center" }}
              >
                <Icon name="close" size={14} color="#fff" />
              </Pressable>
            </Animated.View>
          ))}
        </ScrollView>
      )}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
        <Pressable
          onPress={addPhoto}
          disabled={photos.length >= MAX_PHOTOS}
          accessibilityLabel={t("photoChoose")}
          style={({ pressed }) => ({ ...round(pressed ? c.border : c.surfaceAlt), opacity: photos.length >= MAX_PHOTOS ? 0.4 : 1 })}
        >
          <Icon name="camera" size={20} color={c.text} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0, minHeight: 44, flexDirection: "row", alignItems: "flex-end", backgroundColor: c.surface, borderWidth: 1, borderColor: c.borderStrong, borderRadius: 22, borderCurve: "continuous", paddingLeft: space.lg, paddingRight: 4 }}>
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            placeholder={t("composerPlaceholder")}
            placeholderTextColor={c.textMuted}
            cursorColor={c.primary}
            selectionColor={c.primarySoft}
            multiline
            autoFocus={autoFocus}
            style={{ flex: 1, maxHeight: 140, color: c.text, fontSize: 15.5, lineHeight: 21, paddingTop: 11, paddingBottom: 11, paddingHorizontal: 0 }}
          />
          {onTranscribe && (
            <Pressable
              onPress={() => void startRecording().catch((err) => Alert.alert(t("appName"), (err as Error).message))}
              hitSlop={6}
              accessibilityLabel={t("recording")}
              style={({ pressed }) => ({ width: 36, height: 36, marginBottom: 3, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surfaceAlt : "transparent" })}
            >
              <Icon name="mic" size={20} color={c.textMuted} />
            </Pressable>
          )}
        </View>
        {mode === "stop" ? (
          <StopButton onPress={press} />
        ) : (
          <Pressable
            onPress={press}
            disabled={empty || sending}
            accessibilityLabel="Send"
            style={({ pressed }) => ({ ...round(c.primary), opacity: empty ? 0.4 : pressed ? 0.85 : 1 })}
          >
            <Icon name="send" size={22} color={c.onPrimary} />
          </Pressable>
        )}
      </View>
    </View>
  )
}

/** Dark, with an orange ring spinning around it while Huub works. */
function StopButton({ onPress }: { onPress: () => void }) {
  const { c } = useTheme()
  const turn = useSharedValue(0)
  useEffect(() => {
    turn.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1)
  }, [turn])
  const ring = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }))
  return (
    <Pressable onPress={onPress} accessibilityLabel="Stop" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
      <Animated.View style={[{ position: "absolute", width: 52, height: 52, borderRadius: 26, borderWidth: 2.5, borderColor: "transparent", borderTopColor: c.primary, borderRightColor: c.primary }, ring]} />
      <View style={{ ...round(c.text) }}>
        <Icon name="stop" size={16} color={c.bg} />
      </View>
    </Pressable>
  )
}

/** The live sound level as bars that scroll in from the right. */
function Waveform({ level, color }: { level: number | undefined; color: string }) {
  const [bars, setBars] = useState<number[]>(() => Array(BARS).fill(0))
  useEffect(() => {
    // Metering is in dBFS, about -60 (quiet room) to 0 (shouting).
    const v = level === undefined ? 0 : Math.max(0, Math.min(1, (level + 55) / 50))
    setBars((b) => [...b.slice(1), v])
  }, [level])
  return (
    <View style={{ flex: 1, height: 28, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 2, overflow: "hidden" }}>
      {bars.map((v, i) => (
        <View key={i} style={{ width: 3, height: 4 + v * 24, borderRadius: 2, backgroundColor: color }} />
      ))}
    </View>
  )
}

function Blink({ color }: { color: string }) {
  const o = useSharedValue(1)
  useEffect(() => {
    o.value = withRepeat(withSequence(withTiming(1, { duration: 500 }), withTiming(0.15, { duration: 0 }), withTiming(0.15, { duration: 500 }), withTiming(1, { duration: 0 })), -1)
  }, [o])
  const style = useAnimatedStyle(() => ({ opacity: o.value }))
  return <Animated.View style={[{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }, style]} />
}

function Pulse({ color }: { color: string }) {
  const p = useSharedValue(0)
  useEffect(() => {
    p.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.out(Easing.quad) }), -1)
  }, [p])
  const style = useAnimatedStyle(() => ({ opacity: 0.35 * (1 - p.value), transform: [{ scale: 0.85 + p.value * 0.4 }] }))
  return <Animated.View style={[{ position: "absolute", width: 72, height: 72, borderRadius: 36, backgroundColor: color }, style]} />
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function round(backgroundColor: string) {
  return { width: 44, height: 44, borderRadius: 22, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor }
}
