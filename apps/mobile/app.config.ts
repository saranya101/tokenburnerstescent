import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Parlance", slug: "parlance-android", version: "0.2.1", orientation: "portrait",
  scheme: "parlance", userInterfaceStyle: "light",
  android: { package: "sg.parlance.companion", versionCode: 3, permissions: ["RECORD_AUDIO"] },
  plugins: ["expo-secure-store", "expo-speech-recognition"], experiments: { autolinkingModuleResolution: true },
  extra: {
    apiBaseUrl: process.env.PARLANCE_MOBILE_PUBLIC_API_URL ?? "",

  },
};
export default config;
