import Constants from "expo-constants"
import * as Device from "expo-device"
import * as Notifications from "expo-notifications"
import { router } from "expo-router"
import { useEffect } from "react"
import type { Api } from "./api"

/** Must match PUSH_CHANNEL on the server. */
const CHANNEL = "replies"

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
})

export type PushState = "on" | "denied" | "unavailable"

/**
 * Ask for permission and hand the Expo push token to the server. "unavailable" on simulators and in builds
 * without an EAS project ID (push needs one).
 */
export async function registerPush(api: Api): Promise<PushState> {
  if (!Device.isDevice) return "unavailable"
  if (process.env.EXPO_OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: "Replies",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 120, 200],
      lightColor: "#E85D04",
    })
  }
  let { status } = await Notifications.getPermissionsAsync()
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status
  if (status !== "granted") return "denied"
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
  if (!projectId) return "unavailable"
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId })
  await api.setPushToken(data)
  return "on"
}

/** Open the conversation a tapped notification belongs to, including the one that launched the app. */
export function useNotificationTaps(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const open = (response: Notifications.NotificationResponse | null) => {
      const id = response?.notification.request.content.data?.conversationId
      if (typeof id === "string" && id) router.push({ pathname: "/c/[id]", params: { id } })
    }
    open(Notifications.getLastNotificationResponse())
    const sub = Notifications.addNotificationResponseReceivedListener(open)
    return () => sub.remove()
  }, [enabled])
}
