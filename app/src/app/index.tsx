import { Redirect, router, Stack, useFocusEffect } from "expo-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, FlatList, Linking, Pressable, RefreshControl, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg"
import type { ConversationSummary, SearchResult } from "@server/protocol"
import { AvatarTile, Halo, Icon } from "@/components/art"
import { ConversationRow } from "@/components/conversation-row"
import { showConversationActions } from "@/lib/conversation-actions"
import { t, tagline } from "@/lib/i18n"
import { registerPush } from "@/lib/push"
import { useSession } from "@/lib/session"
import { useAppUpdate } from "@/lib/updates"
import { font, radius, space, useTheme } from "@/theme"

const POLL_MS = 8000

export default function ConversationsScreen() {
  const { session, api } = useSession()
  if (!session || !api) return <Redirect href="/pair" />
  return <Conversations />
}

type Row =
  | { kind: "section"; label: string; pinned?: boolean }
  | { kind: "card"; items: ConversationSummary[] }
  | { kind: "conversation"; item: ConversationSummary }
  | { kind: "result"; result: SearchResult }

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
  const firstName = session?.me.person.name?.split(" ")[0] ?? null

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
    const rest = all.filter((x) => !x.pinned).map((item): Row => ({ kind: "conversation", item }))
    if (!pinned.length) return rest
    return [{ kind: "section", label: t("pinned"), pinned: true }, { kind: "card", items: pinned }, ...(rest.length ? [{ kind: "section" as const, label: t("recent") }, ...rest] : [])]
  }, [list, results])

  const actions = (item: ConversationSummary) => () => showConversationActions(api!, item, changed)

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ paddingTop: insets.top + space.sm, paddingLeft: 18, paddingRight: space.md, paddingBottom: space.md, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <AvatarTile />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: font.size.title, lineHeight: font.lineHeight.title }}>{t("appName")}</Text>
          <Text numberOfLines={1} style={{ color: c.textMuted, fontSize: 13 }}>
            {tagline(firstName)}
          </Text>
        </View>
        <Pressable onPress={() => router.push("/settings")} hitSlop={6} accessibilityLabel={t("settings")} style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surfaceAlt : "transparent" })}>
          <Icon name="settings" size={22} color={c.text} />
        </Pressable>
      </View>

      <View style={{ marginHorizontal: space.lg, marginBottom: 6, height: 46, borderRadius: 16, borderCurve: "continuous", backgroundColor: c.surfaceAlt, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 }}>
        <Icon name="search" size={20} color={c.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("searchPlaceholder")}
          placeholderTextColor={c.textMuted}
          returnKeyType="search"
          autoCorrect={false}
          style={{ flex: 1, color: c.text, fontSize: font.size.label, paddingVertical: 0 }}
        />
        {searching ? (
          <ActivityIndicator size="small" color={c.primary} />
        ) : (
          !!query && (
            <Pressable onPress={() => setQuery("")} hitSlop={10} accessibilityLabel={t("cancel")}>
              <Icon name="close" size={16} color={c.textMuted} />
            </Pressable>
          )
        )}
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row, i) => (row.kind === "section" ? `s-${row.label}` : row.kind === "card" ? "card" : row.kind === "conversation" ? row.item.id : `r-${row.result.conversation.id}-${i}`)}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: space.xs, paddingBottom: insets.bottom + 120, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.primary} colors={[c.primary]} progressBackgroundColor={c.surface} />}
        ListHeaderComponent={
          <>
            {!results && <NewApkCard />}
            {!!error && (
              <Text selectable style={{ color: c.danger, fontSize: font.size.small, paddingHorizontal: 22, paddingVertical: space.sm }}>
                {error}
              </Text>
            )}
          </>
        }
        ListEmptyComponent={
          results ? (
            <Text style={{ color: c.textMuted, textAlign: "center", padding: space.xxl, fontSize: font.size.label }}>{t("noResults", { q: query.trim() })}</Text>
          ) : list ? (
            <EmptyList name={firstName} />
          ) : undefined
        }
        ListFooterComponent={
          !results && list?.length ? (
            <Pressable onPress={() => router.push("/archived")} style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.xl }}>
              <Icon name="archive" size={18} color={c.textMuted} />
              <Text style={{ color: c.textMuted, fontSize: font.size.small, fontWeight: "600" }}>{t("archivedLink")}</Text>
            </Pressable>
          ) : undefined
        }
        renderItem={({ item: row }) =>
          row.kind === "section" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 22, paddingTop: 14, paddingBottom: 6 }}>
              {row.pinned && <Icon name="pin" size={13} color={c.textMuted} />}
              <Text style={{ color: c.textMuted, fontSize: 11.5, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}>{row.label}</Text>
            </View>
          ) : row.kind === "card" ? (
            <View style={{ marginHorizontal: space.md, backgroundColor: c.surface, borderRadius: radius.card, borderCurve: "continuous", borderWidth: 1, borderColor: c.border, boxShadow: c.shadow, overflow: "hidden" }}>
              {row.items.map((item, i) => (
                <ConversationRow key={item.id} item={item} grouped first={i === 0} onLongPress={actions(item)} />
              ))}
            </View>
          ) : row.kind === "conversation" ? (
            <ConversationRow item={row.item} onLongPress={actions(row.item)} />
          ) : (
            <ConversationRow item={row.result.conversation} snippet={row.result.snippet} />
          )
        }
      />

      <Fade height={90} bottom={0} />
      <Pressable
        onPress={() => router.push({ pathname: "/c/[id]", params: { id: "new" } })}
        accessibilityLabel={t("newConversation")}
        style={({ pressed }) => ({
          position: "absolute",
          right: space.lg,
          bottom: insets.bottom + space.lg,
          height: 58,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingLeft: 18,
          paddingRight: 22,
          backgroundColor: c.primary,
          borderRadius: radius.fab,
          borderCurve: "continuous",
          boxShadow: c.fabShadow,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        })}
      >
        <Icon name="new" size={22} color={c.onPrimary} />
        <Text style={{ color: c.onPrimary, fontFamily: font.rounded, fontSize: font.size.body }}>{t("newConversation")}</Text>
      </Pressable>
    </View>
  )
}

/** A new APK that over-the-air updates can't replace: download it, or put it off until the next start. */
function NewApkCard() {
  const { c } = useTheme()
  const { apk, putOff, later } = useAppUpdate()
  if (!apk || putOff) return null
  return (
    <View style={{ marginHorizontal: space.md, marginTop: space.sm, marginBottom: space.xs, padding: 14, gap: space.md, backgroundColor: c.surface, borderRadius: radius.card, borderCurve: "continuous", borderWidth: 1.5, borderColor: c.questionBorder, boxShadow: c.shadow }}>
      <View style={{ flexDirection: "row", gap: space.md }}>
        <View style={{ width: 44, height: 44, borderRadius: radius.tile, backgroundColor: c.primarySoft, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 22 }}>📲</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: font.size.label, lineHeight: 20 }}>{t("apkTitle")}</Text>
          <Text style={{ color: c.textMuted, fontSize: 13, lineHeight: 18 }}>{t("apkBody")}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: space.lg }}>
        <Pressable onPress={later} hitSlop={8}>
          <Text style={{ color: c.textMuted, fontSize: font.size.small, fontWeight: "600" }}>{t("apkLater")}</Text>
        </Pressable>
        <Pressable
          onPress={() => void Linking.openURL(apk.url)}
          style={({ pressed }) => ({ backgroundColor: c.primary, opacity: pressed ? 0.85 : 1, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: 9 })}
        >
          <Text style={{ color: c.onPrimary, fontFamily: font.rounded, fontSize: font.size.small }}>{t("apkDownload")}</Text>
        </Pressable>
      </View>
    </View>
  )
}

/** The list fades into the background behind the button. */
function Fade({ height, bottom }: { height: number; bottom: number }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom, height: height + insets.bottom }}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.bg} stopOpacity={0} />
            <Stop offset="0.7" stopColor={c.bg} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#fade)" />
      </Svg>
    </View>
  )
}

function EmptyList({ name }: { name: string | null }) {
  const { c } = useTheme()
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xxl, paddingBottom: space.huge * 2 }}>
      <Halo size={104} />
      <Text style={{ color: c.text, fontFamily: font.rounded, fontSize: 23, lineHeight: 29, textAlign: "center", marginTop: space.sm }}>
        {name ? t("greeting", { name }) : t("emptyListTitle")}
      </Text>
      <Text style={{ color: c.textMuted, fontSize: 14.5, lineHeight: 21, textAlign: "center", maxWidth: 260 }}>{t("emptyListBody")}</Text>
    </View>
  )
}
