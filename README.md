# Parlance

Parlance is a hackathon implementation of the DBS Direct Conversational Transaction Agent challenge. It turns a customer's typed or transcribed request into a reviewable banking goal, a deterministic financial plan, an exact-plan passkey approval, and a reconciled result. The conversational model can interpret intent; it never receives banking write authority.

This repository integrates with Tencent TokenHub for language interpretation and with a synthetic mock bank for the demonstrated financial operations. It does **not** connect to DBS or any other real bank.

## What the product demonstrates

- Multi-turn clarification of missing amounts, currencies, accounts, beneficiaries, and genuinely ambiguous saved payees.
- Independent, deterministic semantic validation of the model draft against the original customer text before meaning confirmation.
- Authoritative grounding of customer accounts, saved beneficiaries, and the synthetic Apple/AAPL asset to canonical IDs.
- A separate meaning-confirmation step before deterministic planning and a separate financial-plan review before authorization.
- Single-goal transfers and investments, plus an ordered transfer → conditional SGD-to-USD conversion → AAPL purchase bundle with a protected SGD balance.
- Deterministic refusal when a requested plan would violate a hard constraint, including the protected-balance journey.
- WebAuthn/passkey user verification bound to the confirmed goal or bundle, exact plan hash, plan ID, bank-state version, and approval expiry.
- An allowlisted execution gateway, per-step idempotency, state/quote revalidation, reconciliation, partial-outcome handling, customer activity, and a read-only authenticated Ops Portal.

The customer UI and Ops Portal show recorded lifecycle state rather than advancing through a scripted animation. Screenshots from one completed isolated synthetic run are under [`docs/evidence/acceptance-final-97b1146`](docs/evidence/acceptance-final-97b1146/).

## Authority boundaries

```text
customer text / transcribed voice
  → Tencent TokenHub produces an operation-free IntentDraft
  → deterministic validator compares source text, draft and candidate
  → authoritative grounding + customer meaning confirmation
  → immutable GoalContract or GoalBundleContract
  → deterministic Python compiler + current synthetic bank snapshot
  → exact FinancialPlan + constraints + dependencies + quote bindings
  → customer plan review + WebAuthn user verification
  → server-generated ApprovalEvidence
  → risk/state/goal-preservation checks immediately before dispatch
  → authenticated synthetic bank adapter + idempotency
  → authoritative refresh, reconciliation, audit and customer activity
```

The compiler is the only component that creates executable financial steps. The LLM-facing intent engine has no bank client and its output schema cannot contain steps. API orchestration rechecks risk, state, quotes, and goal preservation immediately before dispatch; the Execution Gateway then enforces stored approval evidence and exact-step equality as the only application path to the bank adapter. PostgreSQL retains workflow and audit evidence. Redis is non-authoritative coordination infrastructure.

See [`docs/architecture.md`](docs/architecture.md), [`docs/contracts.md`](docs/contracts.md), and [`docs/threat-model.md`](docs/threat-model.md) for the boundaries and residual risks.

## Repository layout

- `apps/web` — customer banking experience, passkey ceremony client, and authenticated read-only Ops Portal.
- `apps/api` — orchestration, ownership checks, persistence, risk controls, WebAuthn verification, execution, and reconciliation.
- `packages/intent-engine` — TokenHub adapters, grounding, ambiguity handling, and independent deterministic validation.
- `packages/contracts` — strict shared wire schemas and fixtures.
- `packages/db` — Prisma schema, migrations, and disposable demo grounding seed.
- `services/compiler` — deterministic Python planner and hard-constraint enforcement.
- `services/mock-bank` — authenticated synthetic bank, quotes, guarded writes, idempotency, holdings, and failure scenarios.
- `apps/worker` — recovery/outbox worker; intentionally excluded from the safe local stack.

## Prerequisites

- Node.js 24 and pnpm 11.19
- Python 3.12+
- PostgreSQL with the `vector` extension
- Redis when exercising queue/cache-dependent paths
- A browser and platform authenticator for a manual local WebAuthn demonstration

Install dependencies:

```bash
pnpm install --frozen-lockfile
python3 -m venv services/compiler/.venv
services/compiler/.venv/bin/pip install -e 'services/compiler[dev]'
```

## Environment configuration

Copy `.env.example` to the gitignored root `.env` and supply local values. Never commit `.env` or credentials. Required names are documented in `.env.example`; the important trust boundaries are:

| Purpose | Environment names |
|---|---|
| Disposable database | `TEST_DATABASE_URL` |
| Prisma child-process bindings | `DATABASE_URL`, `DIRECT_URL` |
| TokenHub interpretation | `TOKENHUB_API_URL`, `TOKENHUB_API_KEY`, `TOKENHUB_MODEL` |
| Service locations | `API_URL`, `COMPILER_URL`, `MOCK_BANK_URL`, `NEXT_PUBLIC_API_URL` |
| Fixed hackathon customer | `PARLANCE_CUSTOMER_USER_ID` |
| Server-to-server separation | `PARLANCE_INTERNAL_API_TOKEN`, `PARLANCE_BANK_API_TOKEN`, `PARLANCE_OPS_API_TOKEN` |
| Operator session | `PARLANCE_OPERATOR_ACCESS_TOKEN`, `PARLANCE_OPERATOR_SESSION_SECRET` |
| WebAuthn | `PARLANCE_WEBAUTHN_RP_ID`, `PARLANCE_WEBAUTHN_ORIGIN` |
| Explicit local demo gates | `PARLANCE_DEMO_MODE`, `PARLANCE_DEMO_WEBAUTHN_ENROLLMENT` |

Use distinct strong local tokens. Browser code receives none of the internal, bank, operations, or operator credentials. Demo passkey enrollment is disabled by default and should be enabled only long enough for a human to enroll a local authenticator; registration never creates a transaction approval.

### Database and seed safety

`TEST_DATABASE_URL` must identify a disposable PostgreSQL database. Integration tests deliberately do not fall back to `DATABASE_URL`. Before any migration or seed, verify the target out of band; never run reset, migration, or seed commands against shared, protected, or production data.

For a newly created disposable database only:

```bash
pnpm --filter @parlance/db prisma:generate
pnpm --filter @parlance/db prisma:validate
pnpm db:setup
```

`db:setup` does not independently compare database URLs. Run it only after confirming that the loaded `DATABASE_URL` and `DIRECT_URL` both identify the intended disposable target; `TEST_DATABASE_URL` is never an implicit fallback.

The seed is for the fixed-customer hackathon environment. Its grounding fixture contains the canonical mock-bank beneficiary IDs (`ben-john-tan`, `ben-john-lim`, `ben-ntu`), two distinct John aliases, SGD support for both John beneficiaries, and Apple/AAPL aliases. It does not delete legacy records or manufacture a successful financial outcome. Conditional FX is planned only when the authoritative runtime snapshot shows insufficient USD and sufficient SGD after all hard constraints; use an isolated snapshot with that precondition when demonstrating the funded purchase.

## Run locally

The recommended one-terminal command is:

```bash
pnpm dev:safe
```

`dev:safe` starts Web (`3000`), API (`4001`), Mock Bank (`4002`), and Compiler (`8001`). It refuses a missing `TEST_DATABASE_URL`, refuses an indistinguishable development/test database target, binds child `DATABASE_URL` and `DIRECT_URL` explicitly to the test URL, restores balances **and holdings** from the latest authoritative snapshot, validates the mock-bank state version, keeps secrets out of logs, and does not start the worker. A repeated invocation recognizes an owned healthy stack. Use `pnpm dev:restart` for a controlled restart of only verified Parlance-owned process groups.

`pnpm dev` is the raw Turborepo development command. It inherits the caller's environment and does not provide the database, state-restoration, worker-exclusion, or process-ownership protections above; it is not the recommended financial-demo launcher.

Service liveness is exposed at `/health`; readiness-sensitive services expose `/ready`. Stop the safe stack with `Ctrl+C` so the launcher can terminate its verified child process groups.

## Verification

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm security
pnpm test:dev-safe
git diff --check
```

`pnpm security` is an isolated, in-memory judge-readable assurance runner. It covers missing approval, plan/amount and entity mutation, replay/idempotency recovery, changed quotes, customer isolation, model-generated executable actions, and risk/KYC refusal. It removes database and external-service configuration from its child processes. PostgreSQL-only integration cases require an explicitly supplied disposable `TEST_DATABASE_URL` and otherwise skip; a skip is not proof of a passing database guarantee.

Additional evidence and focused tests include:

- [`scripts/security-assurance.mjs`](scripts/security-assurance.mjs) — scenario-to-trust-boundary security report.
- [`services/mock-bank/src/app.test.ts`](services/mock-bank/src/app.test.ts) — quote binding, idempotency, beneficiary currency enforcement, holdings, and synthetic bank authorization.
- [`apps/api/src/orchestration/vertical-slice.test.ts`](apps/api/src/orchestration/vertical-slice.test.ts) — guarded execution, revalidation, recovery, and partial outcomes.
- [`packages/intent-engine/src/validation/validator.test.ts`](packages/intent-engine/src/validation/validator.test.ts) — independent source-to-draft/candidate discrepancy checks.
- [`services/compiler/tests`](services/compiler/tests/) — deterministic single-goal and bundle planning/constraint coverage.
- [`docs/arjun-compiler-evidence.json`](docs/arjun-compiler-evidence.json) — generated compiler scenario evidence retained for review.

## Honest limitations

- This is a synthetic hackathon system, not production DBS integration, real banking execution, regulatory certification, or investment advice.
- Customer authentication intentionally uses one server-configured synthetic customer identity. It is not production multi-user authentication.
- KYC is a persisted synthetic status used by deterministic risk controls; no external identity/KYC provider is integrated.
- TokenHub interpretation can fail or be unavailable. Deterministic validation and explicit clarification/confirmation fail closed, but they do not guarantee perfect interpretation.
- Typed text is the verified customer path. Voice provenance/transcript handling exists in contracts and orchestration tests, but this repository does not include a production speech-capture pipeline.
- Passkeys provide local WebAuthn user verification; production relying-party enrollment, account recovery, attestation policy, and device governance are out of scope.
- The synthetic asset catalog currently contains Apple/AAPL with deterministic synthetic pricing. It is not a licensed market-data feed.
- Multi-step execution is ordered and reconciled but not atomic. A later failure can leave a truthful partial outcome requiring review; the system does not claim automatic rollback.
- The worker is excluded from `dev:safe`; recovery processing requires a separate operator decision and must not be casually enabled.
- Repository screenshots and audit artifacts are evidence of a specific isolated run, not a database backup or proof of production compliance.
