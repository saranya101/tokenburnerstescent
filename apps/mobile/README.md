# Parlance Android companion

Version 0.2.0 uses first-party email/password signup and login, shared with the website. Any valid email can register, including Gmail; no verification email is sent and Auth0 is not used. Passwords require 10–128 characters. New accounts have empty synthetic banking profiles and cannot claim existing customers' data by email.

Set `PARLANCE_MOBILE_PUBLIC_API_URL` to the HTTPS website origin before prebuild and APK compilation. No identity provider/client ID/audience is required. Session credentials are kept in Expo SecureStore. Login, token rotation, logout and customer ownership are verified by the server. See `docs/first-party-auth.md` for server configuration and migration details.

Run `pnpm --filter @parlance/mobile check:connection`, `pnpm --filter @parlance/mobile test` and `pnpm --filter @parlance/mobile typecheck`. With Java 17, Android SDK 36 and NDK 27.1.12297006, run `pnpm --filter @parlance/mobile prebuild`, then `./gradlew :app:assembleRelease` from `apps/mobile/android`. The GitHub `Android APK` workflow provides the same build without a local SDK.

Output: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. This demo release uses debug signing and includes its JavaScript bundle; no Metro server is required. Physical-device signup/login verification is separate from a successful build. Native passkeys, Digital Asset Links and financial execution remain disabled/unverified. Voice requires microphone permission and an installed recognition service.

The older Auth0 plan-review APK is retained in the October 16 release as an archive; use the newly published email-login APK when available.
