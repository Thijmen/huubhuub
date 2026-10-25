import { Link, Redirect, router, Stack, useFocusEffect } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native"
import Animated, { FadeIn } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { ConversationSummary } from "@server/protocol"
import { HuubAvatar, Icon } from "@/components/art"
import { relativeTime, t } from "@/lib/i18n"
import { registerPush } from "@/lib/push"
import { useSession } from "@/lib/session"
import { font, radius, space, useTheme } from "@/theme"

const POLL_MS = 8000

export default function ConversationsScreen() {
  const { session, api } = useSession()
  if (!session || !api) return <Redirect href="/pair" />
  return <Conversations />
}

function Conversations() {
  const { c } = useTheme()
  const { api, session } = useSession()
  const insets = useSafeAreaInsets()
  const [list, setList] = useState<ConversationSummary[]>()
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const pushed = useRef(false)

  const load = useCallback(async () => {
    try {
      setList((await api!.conversations()).conversations)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [api])

  // Refresh while the list is on screen, so titles and "typing" stay current.
  useFocusEffect(
    useCallback(() => {
      void load()
      const timer = setInterval(() => void load(), POLL_MS)
      return () => clearInterval(timer)
    }, [load]),
  )

  useEffect(() => {
    if (pushed.current || !api) return
    pushed.current = true
    void registerPush(api).catch(() => {})
  }, [api])

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: t("conversations"),
          headerLeft: () => (
            <View style={{ marginRight: space.sm }}>
              <HuubAvatar size={30} />
            </View>
          ),
          headerRight: () => (
            <Link href="/settings" asChild>
              <Pressable hitSlop={10} accessibilityLabel={t("settings")}>
                <Icon name="settings" color={c.text} />
              </Pressable>
            </Link>
          ),
        }}
      />
      <FlatList
        data={list ?? []}
        keyExtractor={(item) => item.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: space.lg, gap: space.sm, paddingBottom: insets.bottom + 110, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.primary} colors={[c.primary]} />}
        ListHeaderComponent={
          error ? (
            <Text selectable style={{ color: c.danger, fontSize: font.size.small, paddingBottom: space.sm }}>
              {error}
            </Text>
          ) : undefined
        }
        ListEmptyComponent={list ? <EmptyList name={session?.me.person.name ?? null} /> : undefined}
        renderItem={({ item }) => <Row item={item} />}
      />
      <Pressable
        onPress={() => router.push({ pathname: "/c/[id]", params: { id: "new" } })}
        accessibilityLabel={t("newConversation")}
        style={({ pressed }) => ({
          position: "absolute",
          right: space.xl,
          bottom: insets.bottom + space.xl,
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          backgroundColor: c.primary,
          borderRadius: radius.fab,
          borderCurve: "continuous",
          paddingHorizontal: space.xl,
          paddingVertical: space.lg,
          boxShadow: "0 6px 18px rgba(232, 93, 4, 0.35)",
          transform: [{ scale: pressed ? 0.97 : 1 }],
        })}
      >
        <Icon name="new" color={c.onPrimary} />
        <Text style={{ color: c.onPrimary, fontFamily: font.rounded, fontSize: font.size.label }}>{t("newConversation")}</Text>
      </Pressable>
    </>
  )
}

function Row({ item }: { item: ConversationSummary }) {
  const { c } = useTheme()
  return (
    <Link href={{ pathname: "/c/[id]", params: { id: item.id } }} asChild>
      <Pressable
        style={({ pressed }) => ({
          backgroundColor: pressed ? c.surfaceAlt : c.surface,
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          padding: space.lg,
          gap: space.xs,
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontFamily: font.roundedSemi, fontSize: font.size.heading, lineHeight: font.lineHeight.heading }}>
            {item.title || t("untitled")}
          </Text>
          <Text style={{ color: c.textMuted, fontSize: font.size.caption, fontVariant: ["tabular-nums"] }}>{relativeTime(item.updatedAt)}</Text>
        </View>
        {item.busy ? (
          <Animated.Text entering={FadeIn} style={{ color: c.primaryText, fontSize: font.size.small, lineHeight: font.lineHeight.small, fontWeight: "600" }}>
            {t("typing")}
          </Animated.Text>
        ) : (
          !!item.preview && (
            <Text numberOfLines={2} style={{ color: c.textMuted, fontSize: font.size.small, lineHeight: font.lineHeight.small }}>
              {item.preview}
            </Text>
          )
        )}
      </Pressable>
    </Link>
  )
}

function EmptyList({ name }: { name: string | null }) {
  const { c } = useTheme()
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xxl }}>
      <HuubAvatar size={88} />
      <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: font.size.title, textAlign: "center" }}>
        {name ? t("greeting", { name: name.split(" ")[0]! }) : t("emptyListTitle")}
      </Text>
      <Text style={{ color: c.textMuted, fontSize: font.size.body, lineHeight: font.lineHeight.body, textAlign: "center" }}>{t("emptyListBody")}</Text>
    </View>
  )
}
