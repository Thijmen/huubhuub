import { Nunito_700Bold, Nunito_800ExtraBold, useFonts } from "@expo-google-fonts/nunito"
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"
import { useNotificationTaps } from "@/lib/push"
import { SessionProvider, useSession } from "@/lib/session"
import { UpdatesProvider } from "@/lib/updates"
import { font, useTheme } from "@/theme"

void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  return (
    <SessionProvider>
      <UpdatesProvider>
        <Root />
      </UpdatesProvider>
    </SessionProvider>
  )
}

function Root() {
  const { c, dark } = useTheme()
  const { session } = useSession()
  const [fontsLoaded] = useFonts({ Nunito_700Bold, Nunito_800ExtraBold })
  const ready = fontsLoaded && session !== undefined
  useNotificationTaps(Boolean(session))

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])
  if (!ready) return null

  const base = dark ? DarkTheme : DefaultTheme
  const theme = { ...base, colors: { ...base.colors, primary: c.primary, background: c.bg, card: c.bg, text: c.text, border: c.border } }
  return (
    <ThemeProvider value={theme}>
      <StatusBar style={dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.bg },
          headerShadowVisible: false,
          headerTintColor: c.text,
          headerTitleStyle: { fontFamily: font.rounded, color: c.text },
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: c.bg },
        }}
      >
        {/* A phone that gets signed out (or never was) only has the sign-in screen. */}
        <Stack.Protected guard={Boolean(session)}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="c/[id]" options={{ title: "" }} />
          <Stack.Screen name="archived" />
          <Stack.Screen name="settings/index" />
          <Stack.Screen name="settings/persona" />
          <Stack.Screen name="settings/memory" />
          <Stack.Screen name="settings/reminders" />
          <Stack.Screen name="settings/spending" />
        </Stack.Protected>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="pair" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  )
}
