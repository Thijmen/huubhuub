import { router, Stack, useLocalSearchParams } from "expo-router"
import { useMemo, useRef, useState, type ReactNode } from "react"
import { FlatList, Pressable, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Halo, HuubAvatar, Icon, Spinner } from "@/components/art"
import { Composer, type ComposerHandle } from "@/components/composer"
import { KeyboardView } from "@/components/keyboard-view"
import { DayLabel, HuubBubble, ToolRun, UserBubble, WorkingLine } from "@/components/message"
import { QuestionCard } from "@/components/question-card"
import { assistantText } from "@/lib/chat-state"
import { itemsOf } from "@/lib/chat-items"
import { showConversationActions } from "@/lib/conversation-actions"
import { t, toolText, type Key } from "@/lib/i18n"
import type { Photo } from "@/lib/media"
import { useApi, useSession } from "@/lib/session"
import { topicOf } from "@/lib/topic"
import { useConversation } from "@/lib/use-conversation"
import { font, space, useTheme } from "@/theme"

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return id === "new" ? <NewChat /> : <Chat id={id} />
}

const SUGGESTIONS = [
  { emoji: "🍝", n: 1 },
  { emoji: "⏰", n: 2 },
  { emoji: "🚲", n: 3 },
  { emoji: "✉️", n: 4 },
] as const

/** A conversation that doesn't exist yet: it's created with the first message. */
function NewChat() {
  const { c } = useTheme()
  const api = useApi()
  const { session } = useSession()
  const insets = useSafeAreaInsets()
  const composer = useRef<ComposerHandle>(null)
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
      <Stack.Screen options={{ headerTitle: () => <HeaderTitle title={t("newConversation")} subtitle={t("newChatSub")} /> }} />
      <HeaderLine />
      <KeyboardView>
        <View style={{ flex: 1, alignItems: "center", paddingTop: 34, paddingHorizontal: space.xl }}>
          <Halo size={104} />
          <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: 23, lineHeight: 29, textAlign: "center", marginTop: 18 }}>{t("newChatTitle")}</Text>
          <Text style={{ color: c.textMuted, fontSize: 14.5, lineHeight: 21, textAlign: "center", marginTop: 6, maxWidth: 270 }}>{t("newChatBody")}</Text>
          {!!error && (
            <Text selectable style={{ color: c.danger, textAlign: "center", marginTop: space.md }}>
              {error}
            </Text>
          )}
          <View style={{ flex: 1 }} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 9, width: "100%", marginBottom: 10 }}>
            {SUGGESTIONS.map((s) => (
              <Pressable
                key={s.n}
                onPress={() => composer.current?.fill(t(`sugg${s.n}Text` as Key))}
                style={({ pressed }) => ({
                  flexBasis: "47%",
                  flexGrow: 1,
                  backgroundColor: pressed ? c.surfaceAlt : c.surface,
                  borderColor: c.border,
                  borderWidth: 1,
                  borderRadius: 18,
                  borderCurve: "continuous",
                  paddingHorizontal: 12,
                  paddingVertical: 11,
                })}
              >
                <Text style={{ fontSize: 20, marginBottom: 5 }}>{s.emoji}</Text>
                <Text style={{ color: c.text, fontSize: font.size.small, lineHeight: 19, fontWeight: "600" }}>{t(`sugg${s.n}Title` as Key)}</Text>
                <Text style={{ color: c.textMuted, fontSize: 12.5, lineHeight: 17, marginTop: 1 }}>{t(`sugg${s.n}Hint` as Key)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={{ paddingBottom: insets.bottom }}>
          <Composer ref={composer} busy={false} onSend={send} onStop={() => {}} onTranscribe={session?.me.features.voice ? async (audio, mime) => (await api.transcribe(audio, mime)).text : undefined} />
        </View>
      </KeyboardView>
    </>
  )
}

function Chat({ id }: { id: string }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const { session, api } = useSession()
  const composer = useRef<ComposerHandle>(null)
  const { state, error, send, stop, answer, loadOlder, transcribe, organised } = useConversation(id)

  // Newest first, for an inverted list that starts at the bottom.
  const items = useMemo(() => itemsOf(state).reverse(), [state])
  const topic = topicOf(state.title, id)

  const last = state.messages.at(-1)
  const streaming = last?.role === "assistant" && !last.done && assistantText(last) !== ""
  const toolRunning = state.tools.some((x) => x.status === "running")
  const showWorking = state.busy && !state.question && !streaming && (!toolRunning || state.retry !== null)

  const subtitle = state.question ? (
    <Text style={{ color: c.accent, fontWeight: "600", fontSize: 12.5 }}>{t("headerAsking")}</Text>
  ) : state.busy ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <Spinner size={10} width={1.8} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: c.primaryText, fontWeight: "600", fontSize: 12.5 }}>
        {state.activity ? t("headerDoing", { what: lowerFirst(toolText(state.activity.kind, state.activity.detail, false)) }) : streaming ? `${t("typing")}…` : t("headerThinking")}
      </Text>
    </View>
  ) : (
    <Text style={{ color: c.textMuted, fontSize: 12.5 }}>{state.telegram ? t("headerTelegram") : t("headerIdle")}</Text>
  )

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => <HeaderTitle avatar title={state.title ? `${topic.emoji ? `${topic.emoji} ` : ""}${topic.title}` : state.loaded ? t("untitled") : ""} subtitle={subtitle} />,
          headerRight: () =>
            state.loaded && api ? (
              <Pressable
                hitSlop={6}
                accessibilityLabel={t("archive")}
                onPress={() => showConversationActions(api, { id, title: state.title, pinned: state.pinned, archived: state.archived }, organised)}
                style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surfaceAlt : "transparent" })}
              >
                <Icon name="more" size={22} color={c.text} />
              </Pressable>
            ) : null,
        }}
      />
      <HeaderLine />
      <KeyboardView>
        <FlatList
          inverted
          data={items}
          keyExtractor={(item) => (item.kind === "user" || item.kind === "huub" ? item.message.id : item.kind === "pending" ? item.pending.id : item.id)}
          contentContainerStyle={{ paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: 10, gap: 10 }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.3}
          ListHeaderComponent={
            <View style={{ gap: 10 }}>
              {showWorking && <WorkingLine retry={state.retry} />}
              {state.question && <QuestionCard question={state.question} onAction={(a) => void answer(a)} onTypeOwn={() => composer.current?.focus()} />}
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
            item.kind === "day" ? (
              <DayLabel label={item.label} />
            ) : item.kind === "pending" ? (
              <UserBubble text={item.pending.text} images={item.pending.images.map((uri) => ({ uri }))} pending />
            ) : item.kind === "user" ? (
              <UserBubble text={item.message.text} images={item.message.images} />
            ) : item.kind === "tools" ? (
              <ToolRun tools={item.tools} live={item.live} />
            ) : (
              <HuubBubble message={item.message} showAvatar={item.showAvatar} notes={item.notes} />
            )
          }
        />
        <View style={{ paddingBottom: insets.bottom }}>
          <Composer ref={composer} busy={state.busy} onSend={send} onStop={() => void stop()} onTranscribe={session?.me.features.voice ? transcribe : undefined} />
        </View>
      </KeyboardView>
    </>
  )
}

/** The header's middle: Huub, the conversation's title, and what Huub is up to. */
function HeaderTitle({ title, subtitle, avatar }: { title: string; subtitle: ReactNode; avatar?: boolean }) {
  const { c } = useTheme()
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, maxWidth: "100%" }}>
      {avatar && <HuubAvatar size={34} />}
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: c.text, fontFamily: font.rounded, fontSize: 17, lineHeight: 21 }}>
          {title}
        </Text>
        {typeof subtitle === "string" ? (
          <Text numberOfLines={1} style={{ color: c.textMuted, fontSize: 12.5 }}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
    </View>
  )
}

/** A hairline under the header. */
function HeaderLine() {
  const { c } = useTheme()
  return <View style={{ height: 1, backgroundColor: c.border }} />
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLocaleLowerCase() + s.slice(1) : s
}
