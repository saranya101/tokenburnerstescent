import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Parlance", slug: "parlance-android", version: "0.1.0", orientation: "portrait",
  scheme: "parlance", userInterfaceStyle: "light",
  android: { package: "sg.parlance.companion", versionCode: 1, permissions: ["RECORD_AUDIO"] },
  plugins: ["expo-secure-store", "expo-speech-recognition"], experiments: { autolinkingModuleResolution: true },
  extra: {
    apiBaseUrl: process.env.PARLANCE_MOBILE_PUBLIC_API_URL ?? "",
    oidcIssuer: process.env.PARLANCE_MOBILE_PUBLIC_OIDC_ISSUER ?? "",
    oidcClientId: process.env.PARLANCE_MOBILE_PUBLIC_OIDC_CLIENT_ID ?? "",
    oidcAudience: process.env.PARLANCE_MOBILE_PUBLIC_OIDC_AUDIENCE ?? "",
  },
};
export default config;
