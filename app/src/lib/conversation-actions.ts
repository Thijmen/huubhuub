import { Alert } from "react-native"
import type { ConversationSummary } from "@server/protocol"
import type { Api } from "./api"
import { t } from "./i18n"

/** The pin and archive menu for a conversation, from a long press or the chat's header. */
export function showConversationActions(api: Api, conv: Pick<ConversationSummary, "id" | "title" | "pinned" | "archived">, onChange: (c: ConversationSummary) => void): void {
  const update = (patch: { pinned?: boolean; archived?: boolean }) =>
    api
      .update(conv.id, patch)
      .then(onChange)
      .catch((err: Error) => Alert.alert(t("appName"), err.message))
  Alert.alert(conv.title || t("untitled"), undefined, [
    ...(conv.archived ? [] : [{ text: conv.pinned ? t("unpin") : t("pin"), onPress: () => void update({ pinned: !conv.pinned }) }]),
    { text: conv.archived ? t("unarchive") : t("archive"), onPress: () => void update({ archived: !conv.archived }) },
    { text: t("cancel"), style: "cancel" as const },
  ])
}
