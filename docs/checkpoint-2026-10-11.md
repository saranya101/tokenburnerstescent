# Parlance verified development checkpoint — 11 October 2026

## Git position

- Branch: `saranya`
- Base commit before this checkpoint: `6cc9108c50f41d4c288d1da2ae22119153b9f0a3`
- The checkpoint commit containing this note is the next local commit on that branch. Its authoritative hash is the value of `git rev-parse HEAD` after the commit is created; a commit cannot embed its own hash.
- No remote push is part of this checkpoint.

## Completed capabilities

- DBS-inspired customer banking interface, account and activity views, investments dashboard, and Saved Payees.
- Authenticated customer-state reads with customer/operator separation and server-side credential handling.
- Authoritative beneficiary and asset grounding, including Apple/AAPL aliases and ambiguous John beneficiary selection.
- Structured multi-turn clarification for incomplete transfers without inventing amounts, currencies, recipients, or accounts.
- Meaning confirmation kept separate from deterministic financial-plan review and passkey-bound authorization.
- Standalone Apple acquisition and explicitly requested SGD-funded investment planning with quote, fee, reserve, state-version, and goal-preservation checks.
- Helpful, fail-closed protected-balance refusal presentation using compiler evidence.
- Mock-bank balance and holdings restoration, guarded idempotent execution, and customer activity reporting.
- Verified NTU FX-to-transfer and Apple FX-to-purchase journeys.

## Verification recorded for this checkpoint

- `pnpm --filter @parlance/api test`: 265 passed, 21 skipped database-backed tests.
- `pnpm --filter @parlance/intent-engine test`: 275 passed.
- `pnpm --filter @parlance/mock-bank test`: 26 passed.
- `services/compiler/.venv/bin/pytest services/compiler/tests -q`: 206 passed, 2 dependency deprecation warnings.
- `pnpm --filter @parlance/web test`: 187 passed.
- `pnpm lint`: all eight workspace packages passed; compiler Ruff checks passed.
- `pnpm typecheck`: all eight workspace packages passed.
- `pnpm --filter @parlance/web build`: production build passed and generated all 14 application routes.
- `git diff --check`: passed.
- The protected-balance refusal was visually checked at 1440×900 and 390×844.

The 21 skipped API cases require the disposable external `TEST_DATABASE_URL`; no fallback to `DATABASE_URL` is acceptable. They were previously run separately when that database was explicitly loaded. This checkpoint run did not load it into the test command.

## Read-only synthetic-bank evidence

Verified against `TEST_DATABASE_URL` only for synthetic customer `manual-user-1790040222`:

- Bank-state snapshot: version 25, snapshot ID `cmv3x5v8400448zgq1gynilvl`.
- SGD available balance: S$16,784.01 (`acc-sgd`).
- USD available balance: US$0.00 (`acc-usd`).
- AAPL holding: 2 shares (`asset-aapl`).
- Four completed executions are present: two coordinated `FX_CONVERT → BUY_ASSET` journeys and two `FX_CONVERT → TRANSFER` journeys.
- The latest completed investment ended at state version 25.

This is evidence, not a database backup. No recoverable database dump or backup artifact was found in the repository or local project tree. Managed-provider backup status was not verified.

## Local environment and safe startup

Keep local values in the gitignored root `.env`; never commit it. At minimum, configure:

- A disposable `TEST_DATABASE_URL` distinct from any development or production database. The safe launcher binds both `DATABASE_URL` and `DIRECT_URL` to this test URL for its child processes.
- Distinct internal, operations, bank, operator-access, and operator-session credentials.
- The fixed synthetic customer ID used by the hackathon demo.
- TokenHub endpoint, model, and API credential.
- WebAuthn RP ID and origin appropriate for localhost.
- Mock-bank initial state version, balances, and holdings consistent with the latest authoritative persisted snapshot.

Start the safe stack from the repository root with:

```sh
pnpm dev:safe
```

This starts Web, API, Mock Bank, and Compiler together. It intentionally excludes the worker. For a controlled restart of verified Parlance-owned processes, use:

```sh
pnpm dev:restart
```

Do not bypass launcher database/state checks, start the worker casually, or manually reset mock-bank state.

## Known limitations and exclusions

- Customer authentication intentionally uses one fixed server-configured customer identity for the hackathon architecture; it is not production multi-user authentication.
- Investment quotes and portfolio values come from the authoritative synthetic bank, not licensed public market data. Historical performance and cost basis are unavailable.
- Automatic recovery processing remains disabled with the worker excluded from `dev:safe`; existing recovery work requires separate review and authorization.
- The 21 external-database API integration tests depend on an explicitly loaded `TEST_DATABASE_URL`.
- No actual database backup has been verified or created by this checkpoint.
- Local `.env` files, `.next`, caches, logs, runtime PID/state files, credentials, and database connection values are intentionally excluded.
- `apps/web/next-env.d.ts` is intentionally excluded from the checkpoint because the production build regenerated its `.next` import paths; the working copy is preserved for review rather than discarded.
