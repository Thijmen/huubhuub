import { Stack, useFocusEffect } from "expo-router"
import { useCallback, useState } from "react"
import { FlatList, Text } from "react-native"
import type { ConversationSummary } from "@server/protocol"
import { ConversationRow } from "@/components/conversation-row"
import { showConversationActions } from "@/lib/conversation-actions"
import { t } from "@/lib/i18n"
import { useApi } from "@/lib/session"
import { font, space, useTheme } from "@/theme"

/** Archived conversations, most recently archived first. Long-press to move one back. */
export default function ArchivedScreen() {
  const { c } = useTheme()
  const api = useApi()
  const [list, setList] = useState<ConversationSummary[]>()
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .conversations(true)
      .then((r) => (setList(r.conversations), setError(null)))
      .catch((err: Error) => setError(err.message))
  }, [api])
  useFocusEffect(load)

  return (
    <>
      <Stack.Screen options={{ title: t("archived") }} />
      <FlatList
        data={list ?? []}
        keyExtractor={(item) => item.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingVertical: space.sm, flexGrow: 1 }}
        ListHeaderComponent={error ? <Text selectable style={{ color: c.danger, paddingHorizontal: 18 }}>{error}</Text> : undefined}
        ListEmptyComponent={list ? <Text style={{ color: c.textMuted, textAlign: "center", padding: space.xxl, fontSize: font.size.body, lineHeight: font.lineHeight.body }}>{t("archivedEmpty")}</Text> : undefined}
        renderItem={({ item }) => <ConversationRow item={item} onLongPress={() => showConversationActions(api, item, () => load())} />}
      />
    </>
  )
}
