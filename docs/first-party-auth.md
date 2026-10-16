# First-party email/password accounts

Both the web and native Android clients use Parlance email/password signup and login. Auth0 redirects, discovery, token exchange and provider configuration have been removed. Any syntactically valid email address can register; no email verification is sent. This proves knowledge of a password, not ownership of the email address or a verified banking identity.

Each signup creates a new customer with an empty synthetic banking profile and REVIEW_REQUIRED risk status. No pre-existing customer is claimed by matching an unverified email. Accounts and transactions remain scoped to the server-generated customer ID. Existing Auth0 users must create a separate password account; old sessions cannot be refreshed into the new authentication system. Password recovery and verified email linking are outside this release.

Access tokens are signed HS256 JWTs with a 15-minute expiry, fixed customer audience, issuer, subject and unique token ID. The server additionally checks the stored token hash, revocation, expiry and identity mapping. Refresh tokens are random 256-bit credentials, stored only as hashes, rotated atomically and limited to 30 days. Browser credentials use Secure, HttpOnly, SameSite=Lax cookies with Origin checks on writes. Native credentials use Expo SecureStore. Passwords use salted scrypt (N=32768, r=8, p=1); signup/login requests are persistently rate limited by email and network.

Configure PARLANCE_AUTH_JWT_SECRET with a unique random secret of at least 32 bytes, distinct from internal/operator/bank secrets. Never embed it in the APK or client code. PARLANCE_WEB_PUBLIC_ORIGIN must match the HTTPS website origin. Android needs only PARLANCE_MOBILE_PUBLIC_API_URL. The existing public web/mobile enable flags still apply.

Deployment requires the additive 20261016010000_first_party_credentials migration (PasswordCredential and AuthThrottle only). Apply through the existing private database connection, then keep automatic migrations disabled. Financial execution and native passkey restrictions remain unchanged. The startup verifier checks first-party identity mappings when the JWT secret is present.

The Android APK workflow builds version 0.2.0 / code 2 using the existing debug signing configuration. It is installable for demonstration and includes the JavaScript bundle. Device login verification and production signing remain separate checks.
