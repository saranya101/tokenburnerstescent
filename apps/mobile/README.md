# Parlance Android companion

Native Expo/React Native customer app. The Android package is `sg.parlance.companion`.

## Required configuration

Build-time values are public endpoints/identifiers only:

- `PARLANCE_MOBILE_PUBLIC_API_URL`: HTTPS origin of the Next.js customer gateway (no `/api/mobile` suffix).
- `PARLANCE_MOBILE_PUBLIC_OIDC_ISSUER`: HTTPS OIDC issuer.
- `PARLANCE_MOBILE_PUBLIC_OIDC_CLIENT_ID`: public native-app client ID with `parlance://auth` redirect URI, authorization code + PKCE, and access tokens for the mobile API audience.

The web server requires `PARLANCE_MOBILE_OIDC_ISSUER`, `PARLANCE_MOBILE_OIDC_AUDIENCE`, `PARLANCE_MOBILE_OIDC_CLIENT_ID`, and `PARLANCE_MOBILE_OIDC_JWKS_URI` (HTTPS). Apply both `ExternalIdentity` and `MobileSession` migrations to the intended database after a deployment review, then provision each `(issuer, subject, userId)` relationship in a trusted administrative process after identity verification. Configure the identity provider to issue an access token with the mobile API audience and the registered native client as `azp`, `client_id`, or `cid`. The app never sends its own customer ID. Do not package or publish server tokens, database URLs, or operator credentials.

The current web customer proxy still uses a configured demo customer without browser login. Protect or disable that route before public deployment. The mobile gateway excludes registration, passkey approval, execution, operator and mock-bank routes. Plans are review-only on Android. Existing web passkeys use a web origin; native passkey approval requires a verified HTTPS RP domain, Digital Asset Links, approved signing origins and backend challenge changes.

## Local build

From the repository root, run `pnpm install` with Node 22. Generate Prisma Client with `pnpm --filter @parlance/db exec prisma generate --schema prisma/schema.prisma`. With JDK 17 and an Android SDK containing Platform 36 and Build Tools 36.0.0:

```sh
cd apps/mobile
pnpm expo prebuild --platform android
cd android
./gradlew :app:assembleRelease
```

The resulting APK is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. The generated release variant currently uses the Android debug signing configuration, so it is an **interim locally installable APK**, not a production release. A production APK needs private release signing configured outside Git.

Without the three public build values, the app opens to a clearly labeled configuration gate. It does not display fixture data as customer data. A native install does not imply a trusted banking session.

## Final APK and deployment prerequisites

The packaged artifact is `output/parlance-mobile-final.apk`. It embeds the JavaScript bundle and does not need Metro. This build is **configuration-gated**: the public HTTPS API URL, OIDC issuer, and native client ID were not supplied, so customer sign-in and live banking reads cannot run yet. Rebuild with those public values after the gateway and identity provider are deployed. The release variant is signed with the local Android debug certificate; it is not a production signed release.

- No native passkey ceremony, authorization, or execution.
- Customer state, activity, operations, and pending clarification, meaning, or plan review use the same customer-scoped API and database as Web. The read/resume routes are implemented, but end-to-end cross-device behavior still requires a configured identity provider, deployed migrations, and an isolated test environment.
- The current APK has no public HTTPS/OIDC configuration embedded, so it opens at the connection setup gate. Rebuild after the public endpoint and client identifiers are supplied; do not add secrets to the build.
- Native passkeys require a verified HTTPS relying-party domain, `assetlinks.json` at `/.well-known/assetlinks.json`, debug and release certificate SHA-256 fingerprints as applicable, an Android Credential Manager integration, and backend verification of Android app origins against exact-plan challenges. Approval and execution routes are deliberately absent from the mobile gateway until all of these are verified.
- The mock bank's in-memory state and idempotency records remain a deployment blocker for restart-safe financial execution.
- Mobile activity displays server execution status and recent settled steps; full paginated statements are unavailable.
- Voice recognition requires Android microphone permission and an installed recognition service; the transcript remains editable before submission.

## Isolated synthetic payees

The default bank catalogue and existing demo grounding fixture remain at the original three payees. An additional twelve synthetic payees are defined in `packages/db/prisma/synthetic-payees-v2.json`, including two Alex records that require recipient clarification. They become available only when the mock bank starts with both `PARLANCE_LOCAL_TEST_MODE=true` and `PARLANCE_SYNTHETIC_PAYEES_V2=true`.

For the same **disposable** customer database, provision the matching customer-owned beneficiary and alias records with `packages/db/prisma/seed-synthetic-payees-v2.mjs`. That script requires those two flags, `TEST_DATABASE_URL` whose database name contains `test`, `isolated`, or `disposable`, and an existing `PARLANCE_CUSTOMER_USER_ID`. It refuses a URL equal to `DATABASE_URL`. It was not run as part of the APK build. Enable the mock-bank catalogue and provision grounding together; otherwise the extra directory entries will not be usable for planning.

For a physical Android phone, enable developer options and USB debugging, connect the phone, check `/root/android-sdk/platform-tools/adb devices -l`, then run `/root/android-sdk/platform-tools/adb install -r output/parlance-mobile-final.apk` from the repository root. Launch with `/root/android-sdk/platform-tools/adb shell monkey -p sg.parlance.companion 1`. This interim APK uses the local debug certificate and must not be distributed as a production release.
