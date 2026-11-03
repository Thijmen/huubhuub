/// <reference types="node" />
import type { ExpoConfig } from "expo/config"
import { existsSync } from "node:fs"
import root from "../package.json"

/**
 * The Expo project that builds the official app, sends its push notifications and serves its over-the-air
 * updates. Fill in once after `bunx eas-cli init` (with EXPO_OWNER below). Forks can set EAS_PROJECT_ID and
 * EXPO_OWNER instead. Without a project the app still works, minus push and updates.
 */
const OFFICIAL_PROJECT_ID = "025416eb-b7d3-4ca0-b1b1-d5b79a2dfe58"
const OFFICIAL_OWNER = "thijmenstavenuiter"
const projectId = process.env.EAS_PROJECT_ID || OFFICIAL_PROJECT_ID || undefined
const owner = process.env.EXPO_OWNER || OFFICIAL_OWNER || undefined
/**
 * Firebase config for Android push. CI writes it to ./google-services.json; the local file comes first so the
 * config, and with it the native fingerprint, is the same however a build or update gets its environment.
 */
const googleServices = existsSync("./google-services.json") ? "./google-services.json" : process.env.GOOGLE_SERVICES_JSON

/** The app ships with the bot's releases, so it carries the bot's version (the root package.json). */
const version = root.version
/** Google Play needs a higher versionCode for every upload: 1.4.2 becomes 1004002. */
const versionCode = (() => {
  const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/).map(Number)
  return major * 1_000_000 + minor * 1_000 + patch
})()
/** The update channel the Play builds listen to (.github/workflows/app-release.yml publishes there). */
const UPDATES_CHANNEL = "production"

const config: ExpoConfig = {
  name: "HuubHuub",
  slug: "huubhuub",
  ...(owner ? { owner } : {}),
  scheme: "huubhuub",
  version,
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  backgroundColor: "#FFF8F0",
  runtimeVersion: { policy: "fingerprint" },
  ...(projectId ? { updates: { url: `https://u.expo.dev/${projectId}`, requestHeaders: { "expo-channel-name": UPDATES_CHANNEL } }, extra: { eas: { projectId } } } : {}),
  ios: {
    bundleIdentifier: "dev.thijmen.apps.huubhuub",
    supportsTablet: false,
  },
  android: {
    package: "dev.thijmen.apps.huubhuub",
    versionCode,
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
    ["expo-camera", { cameraPermission: "HuubHuub uses the camera to take photos for Huub and to scan your invite QR code.", recordAudioAndroid: false }],
    ["expo-notifications", { color: "#E85D04" }],
    ["expo-audio", { microphonePermission: "HuubHuub uses the microphone for voice notes to Huub." }],
    [
      "expo-image-picker",
      {
        photosPermission: "HuubHuub lets you send photos from your library to Huub.",
        cameraPermission: "HuubHuub uses the camera to take photos for Huub and to scan your invite QR code.",
      },
    ],
  ],
  experiments: { typedRoutes: true },
}

export default config
