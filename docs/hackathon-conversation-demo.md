# Parlance conversation demo — 16 October 2026

Live site: https://tokenburnerstescent-production.up.railway.app/chat

## What this demonstrates

Production currently uses `INTENT_INTERPRETER_MODE=MOCK`. The deterministic demo parser makes no live AI calls. The page labels this mode explicitly. TokenHub's existing provider is available through `TOKENHUB` mode; a configured key alone does not activate it. Its default endpoint is `https://tokenhub-intl.tencentcloudmaas.com/v1` and default model is `hy3`. Obtain approval before making chargeable calls or changing production to that mode.

The customer confirms meaning, then reviews a deterministic synthetic banking plan. Financial execution stays disabled. Quotes and asset prices in this demonstration are illustrative.

## Reliable live sequence

1. Sign in with the existing controlled synthetic customer. Open Pay & Transfer.
2. Enter `i want to send 20000 to john`. Choose the intended saved John, then explicitly choose SGD or USD. The same request and clarification identifier continue; no sentinel name is shown. The selected payee's supported currency and current funds determine whether planning succeeds. An unavailable outcome is safe and intentional when the chosen currency or funds do not support the request.
3. Start over and enter `Send SGD 100 to John Lim.` Review the understood amount/payee, then confirm meaning to obtain the plan. Do not describe this meaning confirmation as financial authorization.
4. Enter `Buy one share of Apple.` Review exactly one share and the quoted USD 200 price plus USD 1 fee.
5. Enter the showcase exactly:

   `Okay send hundred dollars to John Lim and then buy one share of Apple stock and use SGD if needed but at least keep $1000 in my SGD account.`

6. Choose **SGD 100** for the transfer. Review exactly two requested actions and the SGD 1,000 minimum. Confirm meaning. Review the combined plan, fees and projected balances. Conditional SGD funding is used only if needed; with the currently seeded USD 5,000 balance, the USD 201 purchase needs no FX. Do not claim an FX conversion happened when the plan contains none.
7. For correction, enter `Send SGD 50 to an eligible saved payee.` The unknown description produces actual eligible saved-payee options. Choose one; the original request is retained. An invalid answer or temporary request error leaves clarification available for retry.

Other regression prompts: `send 100 to John Lim`, `send hundred dollars to John`, `Send SGD 20001 to John Lim`, and `Send SGD 19500 to John Lim but keep at least SGD 1000 in my SGD account`. The first two ask for currency; the latter two demonstrate funding and protected-balance refusals against the seeded balances.

## Root causes and safety boundaries

- The previous mock always emitted recipient `UNRESOLVED`, currency USD and the first numeric token; it never interpreted the payee or supported bundles. The replacement preserves source amounts/names, handles the bounded demo phrases, and sends all output through the existing schemas, grounding and independent semantic checks.
- Unknown references previously offered no saved-payee choices. Fallback options now come from active customer-owned records with provider references. No canonical ID is invented, and candidate IDs are checked against the server-issued options.
- Invalid clarification answers previously overwrote grounding or moved the UI into an unrecoverable error. No-match answers now preserve the pending draft; transient errors remain retryable. Duplicate submission guards remain active.
- The database snapshot disabled transfer planning and supplied no FX quotes. Synthetic plan modelling now permits transfers and uses the mock bank's existing expiring indicative FX quotes. Every bank write in snapshot mode still returns `BANK_EXECUTION_DISABLED`; public passkey execution flags stay disabled.
- The pending ledger migration is not applied. Startup inspection accepts only that specific missing migration in explicitly safe snapshot mode with migrations disabled. All other missing/unexpected migration states remain rejected; durable execution still requires the full schema.

Public execution remains blocked pending current PostgreSQL collation verification, a ledger readiness check, a real HTTPS browser passkey enrollment and exact-plan approval, and a successful authorized durable synthetic execution with reconciliation. Existing identity, ownership, risk, challenge expiry and replay checks remain in place.

## Android

Preserved plan-review APK: https://github.com/saranya101/tokenburnerstescent/releases/download/parlance-plan-review-2026-10-16/parlance-mobile-plan-review.apk

This existing APK is installable and debug-signed. Physical-device login/read verification remains outstanding. Native passkeys, Digital Asset Links and financial execution have not been verified. No APK rebuild is required for the server-side fixes.

## Validation

Targeted conversation and bundle regression suites cover the original request, exact names, spoken hundreds, duplicate Johns, unknown recipients, independent currency clarification, invalid and valid continuation, and absence of premature confirmation. Browser presentation tests cover sentinel suppression and retry recovery. Compiler regressions cover insufficient available funds and the protected minimum balance. Existing composite compiler tests verify conditional FX, fees, balances and deterministic ordering.

Run all four requested package suites, the database and compiler suites, `pnpm typecheck`, `pnpm lint`, `pnpm security:assurance`, and `pnpm build`. Database concurrency and real passkey integration tests require their separately configured disposable databases and remain skipped locally; do not claim they were exercised.

Startup verification checks the configured Auth0 customer mapping and its customer-scoped snapshot. Additional synthetic test users are permitted; seeding still requires an empty database. On the first rollout, production already had the ledger migration and an additional synthetic test user, so the old global single-user assertion prevented startup. Execution flags remain disabled.
