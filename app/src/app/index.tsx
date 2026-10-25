import { Link, Redirect, router, Stack, useFocusEffect } from "expo-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { ConversationSummary, SearchResult } from "@server/protocol"
import { HuubAvatar, Icon } from "@/components/art"
import { ConversationRow } from "@/components/conversation-row"
import { showConversationActions } from "@/lib/conversation-actions"
import { t } from "@/lib/i18n"
import { registerPush } from "@/lib/push"
import { useSession } from "@/lib/session"
import { font, radius, space, useTheme } from "@/theme"

const POLL_MS = 8000

export default function ConversationsScreen() {
  const { session, api } = useSession()
  if (!session || !api) return <Redirect href="/pair" />
  return <Conversations />
}

type Row = { kind: "header"; label: string } | { kind: "conversation"; item: ConversationSummary } | { kind: "result"; result: SearchResult }

function Conversations() {
  const { c } = useTheme()
  const { api, session } = useSession()
  const insets = useSafeAreaInsets()
  const [list, setList] = useState<ConversationSummary[]>()
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
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

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      api!
        .search(q)
        .then((r) => setResults(r.results))
        .catch((err: Error) => setError(err.message))
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [api, query])

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const changed = (conv: ConversationSummary) => {
    setList((l) => (conv.archived ? l?.filter((x) => x.id !== conv.id) : l?.map((x) => (x.id === conv.id ? conv : x))))
    void load()
  }

  const rows = useMemo<Row[]>(() => {
    if (results) return results.map((result) => ({ kind: "result", result }))
    const all = list ?? []
    const pinned = all.filter((x) => x.pinned)
    const rest = all.filter((x) => !x.pinned)
    const items = (xs: ConversationSummary[]) => xs.map((item): Row => ({ kind: "conversation", item }))
    if (!pinned.length) return items(rest)
    return [{ kind: "header", label: t("pinned") }, ...items(pinned), ...(rest.length ? [{ kind: "header" as const, label: t("recent") }, ...items(rest)] : [])]
  }, [list, results])

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
        data={rows}
        keyExtractor={(row, i) => (row.kind === "header" ? `h-${row.label}` : row.kind === "conversation" ? row.item.id : `r-${row.result.conversation.id}-${i}`)}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ padding: space.lg, gap: space.sm, paddingBottom: insets.bottom + 110, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.primary} colors={[c.primary]} />}
        ListHeaderComponent={
          <View style={{ gap: space.sm, paddingBottom: space.xs }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: c.surfaceAlt, borderRadius: radius.md, borderCurve: "continuous", paddingHorizontal: space.md }}>
              <Icon name="search" size={18} color={c.textMuted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={t("searchPlaceholder")}
                placeholderTextColor={c.textMuted}
                returnKeyType="search"
                autoCorrect={false}
                style={{ flex: 1, color: c.text, fontSize: font.size.body, paddingVertical: 10 }}
              />
              {searching ? (
                <ActivityIndicator size="small" color={c.primary} />
              ) : (
                !!query && (
                  <Pressable onPress={() => setQuery("")} hitSlop={8} accessibilityLabel={t("cancel")}>
                    <Icon name="close" size={16} color={c.textMuted} />
                  </Pressable>
                )
              )}
            </View>
            {!!error && (
              <Text selectable style={{ color: c.danger, fontSize: font.size.small }}>
                {error}
              </Text>
            )}
          </View>
        }
        ListEmptyComponent={
          results ? (
            <Text style={{ color: c.textMuted, textAlign: "center", padding: space.xxl }}>{t("noResults", { q: query.trim() })}</Text>
          ) : list ? (
            <EmptyList name={session?.me.person.name ?? null} />
          ) : undefined
        }
        ListFooterComponent={
          !results && list ? (
            <Link href="/archived" asChild>
              <Pressable style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg }}>
                <Icon name="archive" size={18} color={c.textMuted} />
                <Text style={{ color: c.textMuted, fontSize: font.size.label, fontWeight: "600" }}>{t("archivedLink")}</Text>
              </Pressable>
            </Link>
          ) : undefined
        }
        renderItem={({ item: row }) =>
          row.kind === "header" ? (
            <Text style={{ color: c.textMuted, fontSize: font.size.caption, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", paddingTop: space.sm }}>{row.label}</Text>
          ) : row.kind === "conversation" ? (
            <ConversationRow item={row.item} onLongPress={() => showConversationActions(api!, row.item, changed)} />
          ) : (
            <ConversationRow item={row.result.conversation} snippet={row.result.snippet} />
          )
        }
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
