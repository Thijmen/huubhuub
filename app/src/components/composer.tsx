import { IOSOutputFormat, AudioQuality, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState, type RecordingOptions } from "expo-audio"
import * as Haptics from "expo-haptics"
import { Image } from "expo-image"
import { useState } from "react"
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import Animated, { FadeIn, FadeOut } from "react-native-reanimated"
import { ApiError } from "@/lib/api"
import { t } from "@/lib/i18n"
import { PermissionError, pickPhoto, readBase64, type Photo } from "@/lib/media"
import { font, radius, space, useTheme } from "@/theme"
import { Icon } from "./art"

const MAX_PHOTOS = 4

/** AAC in MP4, mono, 16 kHz: small uploads, and the server turns it into what Amazon Transcribe takes. */
const VOICE: RecordingOptions = {
  extension: ".m4a",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 48000,
  android: { outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.HIGH },
  web: {},
}

interface Props {
  busy: boolean
  onSend: (text: string, photos: Photo[]) => Promise<void>
  onStop: () => void
  /** Turn a voice note into text; absent when the server can't. */
  onTranscribe?: (audio: string, mime: string) => Promise<string>
  autoFocus?: boolean
}

/**
 * Where you write, talk or add photos. While Huub works and the composer is empty, the button stops the
 * reply; a message sent while it works is queued.
 */
export function Composer({ busy, onSend, onStop, onTranscribe, autoFocus }: Props) {
  const { c } = useTheme()
  const [text, setText] = useState("")
  const [photos, setPhotos] = useState<Photo[]>([])
  const [sending, setSending] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorder = useAudioRecorder(VOICE)
  const recording = useAudioRecorderState(recorder, 250)
  const empty = !text.trim() && !photos.length
  const mode = recording.isRecording ? "recording" : transcribing ? "transcribing" : busy && empty ? "stop" : empty && onTranscribe ? "mic" : "send"

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
    if (process.env.EXPO_OS === "ios") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
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
      if (process.env.EXPO_OS === "ios") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      return onStop()
    }
    if (mode === "mic") return void startRecording().catch((err) => Alert.alert(t("appName"), (err as Error).message))
    if (mode === "recording") return void finishRecording(true)
    if (mode === "send" && !empty && !sending) void send(text.trim(), photos)
  }

  const seconds = Math.floor(recording.durationMillis / 1000)
  return (
    <View style={{ gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.sm, backgroundColor: c.bg }}>
      {photos.length > 0 && (
        <ScrollView horizontal contentContainerStyle={{ gap: space.sm }} keyboardShouldPersistTaps="handled">
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
        {mode === "recording" ? (
          <Pressable onPress={() => void finishRecording(false)} accessibilityLabel={t("cancel")} style={roundButton(c.surfaceAlt)}>
            <Icon name="close" size={22} color={c.textMuted} />
          </Pressable>
        ) : (
          <Pressable onPress={addPhoto} disabled={photos.length >= MAX_PHOTOS || transcribing} accessibilityLabel={t("photoChoose")} style={roundButton("transparent")}>
            <Icon name="camera" size={24} color={photos.length >= MAX_PHOTOS ? c.border : c.textMuted} />
          </Pressable>
        )}
        {mode === "recording" || mode === "transcribing" ? (
          <View style={{ flex: 1, minHeight: 46, flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: c.primarySoft, borderRadius: radius.xl, paddingHorizontal: space.lg }}>
            {mode === "recording" ? (
              <>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger }} />
                <Text style={{ color: c.primaryText, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                  {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
                </Text>
                <Text style={{ color: c.primaryText, fontSize: font.size.small }}>{t("recording")}</Text>
              </>
            ) : (
              <>
                <ActivityIndicator color={c.primary} size="small" />
                <Text style={{ color: c.primaryText, fontSize: font.size.small }}>{t("transcribing")}</Text>
              </>
            )}
          </View>
        ) : (
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
        )}
        <Pressable
          onPress={press}
          disabled={mode === "transcribing" || (mode === "send" && (empty || sending))}
          accessibilityLabel={mode === "stop" ? "Stop" : mode === "mic" ? "Voice note" : "Send"}
          style={({ pressed }) => ({
            ...roundButton(mode === "stop" ? c.text : mode === "mic" || (mode === "send" && empty) ? c.surfaceAlt : c.primary),
            opacity: pressed ? 0.8 : 1,
          })}
        >
          {mode === "stop" ? (
            <Icon name="stop" size={22} color={c.bg} />
          ) : mode === "mic" ? (
            <Icon name="mic" size={22} color={c.primaryText} />
          ) : mode === "transcribing" ? (
            <ActivityIndicator color={c.onPrimary} size="small" />
          ) : (
            <Icon name="send" size={22} color={mode === "send" && empty ? c.textMuted : c.onPrimary} />
          )}
        </Pressable>
      </View>
    </View>
  )
}

function roundButton(backgroundColor: string) {
  return { width: 46, height: 46, borderRadius: 23, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor }
}
