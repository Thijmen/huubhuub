import { router, Stack, useLocalSearchParams } from "expo-router"
import { useMemo, useState } from "react"
import { FlatList, Pressable, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { AppMessage } from "@server/protocol"
import { HuubAvatar } from "@/components/art"
import { Composer } from "@/components/composer"
import { KeyboardView } from "@/components/keyboard-view"
import { HuubBubble, UserBubble, WorkingLine } from "@/components/message"
import { QuestionCard } from "@/components/question-card"
import type { Pending } from "@/lib/chat-state"
import { t } from "@/lib/i18n"
import type { Photo } from "@/lib/media"
import { useApi, useSession } from "@/lib/session"
import { useConversation } from "@/lib/use-conversation"
import { font, space, useTheme } from "@/theme"

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return id === "new" ? <NewChat /> : <Chat id={id} />
}

/** A conversation that doesn't exist yet: it's created with the first message. */
function NewChat() {
  const { c } = useTheme()
  const api = useApi()
  const { session } = useSession()
  const insets = useSafeAreaInsets()
  const [error, setError] = useState<string | null>(null)
  const send = async (text: string, photos: Photo[]) => {
    try {
      const conv = await api.create(text, photos.map(({ data, name }) => ({ data, name })))
      router.replace({ pathname: "/c/[id]", params: { id: conv.id } })
    } catch (err) {
      setError((err as Error).message)
      throw err
    }
  }
  return (
    <>
      <Stack.Screen options={{ title: t("newConversation") }} />
      <KeyboardView>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xxl }}>
          <HuubAvatar size={72} />
          <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: font.size.title, lineHeight: font.lineHeight.title, textAlign: "center" }}>{t("newChatTitle")}</Text>
          <Text style={{ color: c.textMuted, fontSize: font.size.body, lineHeight: font.lineHeight.body, textAlign: "center" }}>{t("newChatBody")}</Text>
          {!!error && (
            <Text selectable style={{ color: c.danger, textAlign: "center" }}>
              {error}
            </Text>
          )}
        </View>
        <View style={{ paddingBottom: insets.bottom }}>
          <Composer
            busy={false}
            onSend={send}
            onStop={() => {}}
            onTranscribe={session?.me.features.voice ? async (audio, mime) => (await api.transcribe(audio, mime)).text : undefined}
            autoFocus
          />
        </View>
      </KeyboardView>
    </>
  )
}

type Item = { kind: "message"; message: AppMessage; showAvatar: boolean } | { kind: "pending"; pending: Pending }

function Chat({ id }: { id: string }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const { session } = useSession()
  const { state, error, send, stop, answer, loadOlder, transcribe } = useConversation(id)

  // Newest first, for an inverted list that starts at the bottom.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = state.messages.map((m, i) => ({
      kind: "message",
      message: m,
      // The avatar sits by the last of a run of Huub's messages.
      showAvatar: m.role === "assistant" && state.messages[i + 1]?.role !== "assistant",
    }))
    for (const p of state.pending) out.push({ kind: "pending", pending: p })
    return out.reverse()
  }, [state.messages, state.pending])

  const lastIsStreamingText = state.messages.at(-1)?.role === "assistant" && !(state.messages.at(-1) as { done: boolean }).done
  const showWorking = state.busy && !state.question && (state.activity !== null || state.retry !== null || !lastIsStreamingText)

  return (
    <>
      <Stack.Screen options={{ title: state.title ?? (state.loaded ? t("untitled") : "") }} />
      <KeyboardView>
        <FlatList
          inverted
          data={items}
          keyExtractor={(item) => (item.kind === "message" ? item.message.id : item.pending.id)}
          contentContainerStyle={{ padding: space.lg, gap: space.md }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.3}
          ListHeaderComponent={
            <View style={{ gap: space.md }}>
              {showWorking && <WorkingLine activity={state.activity} retry={state.retry} />}
              {state.question && <QuestionCard question={state.question} onAction={(a) => void answer(a)} />}
              {!!state.failure && (
                <Text selectable style={{ color: c.danger, fontSize: font.size.small, paddingLeft: 36 }}>
                  {t("replyFailed", { error: state.failure })}
                </Text>
              )}
              {!!error && (
                <Text selectable style={{ color: c.danger, fontSize: font.size.small, textAlign: "center" }}>
                  {error}
                </Text>
              )}
            </View>
          }
          ListFooterComponent={
            state.older ? (
              <Pressable onPress={() => void loadOlder()} style={{ alignSelf: "center", padding: space.md }}>
                <Text style={{ color: c.accent, fontWeight: "600" }}>{t("loadOlder")}</Text>
              </Pressable>
            ) : undefined
          }
          renderItem={({ item }) =>
            item.kind === "pending" ? (
              <UserBubble text={item.pending.text} images={item.pending.images.map((uri) => ({ uri }))} pending />
            ) : item.message.role === "user" ? (
              <UserBubble text={item.message.text} images={item.message.images} />
            ) : (
              <HuubBubble message={item.message} showAvatar={item.showAvatar} />
            )
          }
        />
        <View style={{ paddingBottom: insets.bottom }}>
          <Composer busy={state.busy} onSend={send} onStop={() => void stop()} onTranscribe={session?.me.features.voice ? transcribe : undefined} />
        </View>
      </KeyboardView>
    </>
  )
}
