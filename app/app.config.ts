/// <reference types="node" />
import type { ExpoConfig } from "expo/config"
import { existsSync } from "node:fs"

/**
 * The Expo project that builds the official app, sends its push notifications and serves its over-the-air
 * updates. Fill in once after `bunx eas-cli init` (with EXPO_OWNER below). Forks can set EAS_PROJECT_ID and
 * EXPO_OWNER instead. Without a project the app still works, minus push and updates.
 */
const OFFICIAL_PROJECT_ID = "025416eb-b7d3-4ca0-b1b1-d5b79a2dfe58"
const OFFICIAL_OWNER = "thijmenstavenuiter"
const projectId = process.env.EAS_PROJECT_ID || OFFICIAL_PROJECT_ID || undefined
const owner = process.env.EXPO_OWNER || OFFICIAL_OWNER || undefined
/** Firebase config for Android push. EAS can provide it as a file environment variable. */
const googleServices = process.env.GOOGLE_SERVICES_JSON ?? (existsSync("./google-services.json") ? "./google-services.json" : undefined)

const config: ExpoConfig = {
  name: "HuubHuub",
  slug: "huubhuub",
  ...(owner ? { owner } : {}),
  scheme: "huubhuub",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  backgroundColor: "#FFF8F0",
  runtimeVersion: { policy: "fingerprint" },
  ...(projectId ? { updates: { url: `https://u.expo.dev/${projectId}` }, extra: { eas: { projectId } } } : {}),
  ios: {
    bundleIdentifier: "nl.thijmen.huubhuub",
    supportsTablet: false,
  },
  android: {
    package: "nl.thijmen.huubhuub",
    adaptiveIcon: {
      backgroundColor: "#E85D04",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    ...(googleServices ? { googleServicesFile: googleServices } : {}),
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-localization",
    "expo-image",
    "expo-font",
    ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 160, backgroundColor: "#FFF8F0", dark: { backgroundColor: "#17130F" } }],
    ["expo-camera", { cameraPermission: "HuubHuub uses the camera to scan your invite QR code.", recordAudioAndroid: false }],
    ["expo-notifications", { color: "#E85D04" }],
  ],
  experiments: { typedRoutes: true },
}

export default config
