import { Nunito_700Bold, Nunito_800ExtraBold, useFonts } from "@expo-google-fonts/nunito"
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"
import { useNotificationTaps } from "@/lib/push"
import { SessionProvider, useSession } from "@/lib/session"
import { font, useTheme } from "@/theme"

void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  return (
    <SessionProvider>
      <Root />
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
        <Stack.Screen name="index" />
        <Stack.Screen name="pair" options={{ headerShown: false }} />
        <Stack.Screen name="c/[id]" options={{ title: "" }} />
        <Stack.Screen name="settings/index" />
      </Stack>
    </ThemeProvider>
  )
}
