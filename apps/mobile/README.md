# Parlance Android companion

Native Expo/React Native customer app. The Android package is `sg.parlance.companion`.

## Required configuration

Build-time values are public endpoints/identifiers only:

- `PARLANCE_MOBILE_PUBLIC_API_URL`: HTTPS origin of the Next.js customer gateway (no `/api/mobile` suffix).
- `PARLANCE_MOBILE_PUBLIC_OIDC_ISSUER`: HTTPS OIDC issuer.
- `PARLANCE_MOBILE_PUBLIC_OIDC_CLIENT_ID`: public native-app client ID with `parlance://auth` redirect URI, authorization code + PKCE, and access tokens for the mobile API audience.
- `PARLANCE_MOBILE_PUBLIC_OIDC_AUDIENCE`: API audience requested during native authorization. It must equal the web server's `PARLANCE_MOBILE_OIDC_AUDIENCE`.

The web server requires `PARLANCE_MOBILE_OIDC_ISSUER`, `PARLANCE_MOBILE_OIDC_AUDIENCE`, `PARLANCE_MOBILE_OIDC_CLIENT_ID`, and `PARLANCE_MOBILE_OIDC_JWKS_URI` (HTTPS). The public issuer string must exactly match OIDC discovery's `issuer`, including its trailing slash, if any. Apply both `ExternalIdentity` and `MobileSession` migrations to an **approved disposable database first**, then provision each `(issuer, subject, userId)` relationship in a trusted administrative process after identity verification. Configure the identity provider to issue a signed access token with the mobile API audience and the registered native client as `azp`, `client_id`, or `cid`. The app never sends its own customer ID. Do not package or publish server tokens, database URLs, or operator credentials.

The public web gateway now requires a verified customer session for customer routes. The mobile gateway independently verifies OIDC identity during token exchange and resolves the customer through `ExternalIdentity`. It excludes registration, passkey approval, execution, operator and mock-bank routes. Plans are review-only on Android. Native passkey approval requires a verified HTTPS RP domain, Digital Asset Links, approved signing origins and backend challenge changes.

The current Railway deployment uses one public Next.js gateway for the authenticated web and mobile routes. Its `API_URL` points to the internal API; the API reaches PostgreSQL, compiler and mock bank privately. The gateway keeps unrelated privileged routes closed in public safe mode. Only server processes receive internal service tokens.

Before building with real public values, run `pnpm --filter @parlance/mobile check:connection` from the repository root. It performs read-only HTTPS discovery, JWKS and unauthenticated gateway checks. It fails if the fixed-customer web proxy returns customer state publicly. This preflight does **not** establish a signed-in session or prove customer mapping; verify those separately on an approved disposable deployment. The native app requests the configured API audience with PKCE and rejects discovery metadata whose issuer or HTTPS endpoints do not match the build configuration.

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

The current [plan-review APK](https://github.com/saranya101/tokenburnerstescent/releases/download/parlance-plan-review-2026-10-16/parlance-mobile-plan-review.apk) embeds the Railway HTTPS origin and matching public Auth0 issuer, native client ID and API audience. It has an embedded JavaScript bundle and does not need Metro. The APK is signed with an Android debug certificate. Its customer login and device reads still require verification on a physical device; it is not a transaction-ready or production-signed release.

- No native passkey ceremony, authorization, or execution.
- Customer state, activity, operations, and pending clarification, meaning, or plan review use the same customer-scoped API and database as Web. End-to-end cross-device behavior requires a verified physical-device Auth0 login and read comparison.
- Native passkeys require a verified HTTPS relying-party domain, `assetlinks.json` at `/.well-known/assetlinks.json`, debug and release certificate SHA-256 fingerprints as applicable, an Android Credential Manager integration, and backend verification of Android app origins against exact-plan challenges. Approval and execution routes are deliberately absent from the mobile gateway until all of these are verified.
- PR #9 implements a PostgreSQL-backed synthetic bank ledger and durable idempotency. The isolated Railway database has been migrated and tested with separate synthetic test records. Public execution remains disabled pending merged deployment, public WebAuthn and native passkey verification.
- Mobile activity displays server execution status and recent settled steps; full paginated statements are unavailable.
- Voice recognition requires Android microphone permission and an installed recognition service; the transcript remains editable before submission.

## Isolated synthetic payees

The default bank catalogue and existing demo grounding fixture remain at the original three payees. An additional twelve synthetic payees are defined in `packages/db/prisma/synthetic-payees-v2.json`, including two Alex records that require recipient clarification. They become available only when the mock bank starts with both `PARLANCE_LOCAL_TEST_MODE=true` and `PARLANCE_SYNTHETIC_PAYEES_V2=true`.

For the same **disposable** customer database, provision the matching customer-owned beneficiary and alias records with `packages/db/prisma/seed-synthetic-payees-v2.mjs`. That script requires those two flags, `TEST_DATABASE_URL` whose database name contains `test`, `isolated`, or `disposable`, and an existing `PARLANCE_CUSTOMER_USER_ID`. It refuses a URL equal to `DATABASE_URL`. It was not run as part of the APK build. Enable the mock-bank catalogue and provision grounding together; otherwise the extra directory entries will not be usable for planning.

For a physical Android phone, download the plan-review APK from the release link above and open it on the phone to install. Android may ask you to allow installs from the browser or file manager. Alternatively, with Android SDK platform tools and USB debugging, run `adb install -r parlance-mobile-plan-review.apk`, then launch `sg.parlance.companion`. This interim APK uses an Android debug certificate; verify sign-in and customer reads on the device before describing it as connected.
