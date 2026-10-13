# Threat model

Parlance treats language-model output, browser input, customer-supplied identifiers, stale financial state, and replayed requests as untrusted. This document describes implemented controls in the hackathon system and the risks that remain. It is not a claim of regulatory certification or production-bank security review.

## Trust boundaries

1. **Customer/browser → Web BFF/API.** The browser has no service credentials. Customer identity comes from server configuration in the fixed-customer demo architecture, and API resources are ownership-checked.
2. **Interpreter → grounding and validation.** Tencent TokenHub returns an operation-free intent draft. Independent deterministic code compares the original submitted text, draft, grounded candidate, constraints, preferences, and bundle coverage before a candidate can be confirmed.
3. **Confirmed meaning → compiler.** Only confirmed canonical IDs and current bank state cross into the deterministic compiler. Original prose and model-suggested actions do not become executable steps.
4. **Plan review → WebAuthn.** A one-time challenge binds the customer, confirmed contract hash/version, financial plan ID/hash, bank-state version, and expiry. Server verification creates approval evidence; rendering or reviewing a plan grants no authority.
5. **API → synthetic bank.** The Execution Gateway checks approval evidence, plan status/expiry, exact operation equality, state/quote freshness, risk, goal preservation, and idempotency before using a distinct server-side bank credential.
6. **Execution → reconciliation.** Each accepted operation is refreshed against authoritative bank state and persisted with step status, bank reference, state version, audit events, and idempotency evidence. Unknown effects are not reported as settled.

## Threats, implemented controls, and residual risk

| Threat | Implemented control | Residual risk / limitation |
|---|---|---|
| Prompt injection or model-generated executable actions | Strict operation-free intent schemas; TokenHub has no bank client; independent source-evidence validator; only the deterministic compiler emits allowlisted steps; security assurance runner includes executable-action rejection. | Natural-language coverage is not mathematically complete. Novel phrasing can be rejected or require clarification, and adversarial evaluation should continue. |
| Model omits, invents, or alters amount/entity/constraint/order | Validator compares original source text with draft and grounded candidate; bundle coverage validates independently requested goals and dependencies; unresolved/ambiguous references block confirmation; customer confirms complete meaning. | Interpretation quality still affects usability. The fixed deterministic evidence extractors support the implemented goal vocabulary, not arbitrary banking language. |
| Browser supplies another customer ID or opaque resource ID | Trusted server-side customer principal; route authorization and ownership traversal across goals, bundles, plans, challenges, approvals, and executions; cross-customer negative tests. | Demo uses one fixed customer identity rather than a production identity/session provider. |
| Browser or customer obtains operator/bank credentials | Customer BFF routes inject only the internal server credential; operator access uses a separate server-side session; mock-bank operations and admin controls require distinct bank/ops tokens and fail closed when tokens collide or are absent. | Local environment security and secret rotation are operational responsibilities; no managed secrets service is included. |
| Missing, forged, replayed, or plan-mismatched approval | WebAuthn user verification; one-time persisted challenges; approval payload binds goal/bundle hash, plan ID/hash, state version and expiry; gateway requires matching stored approval evidence; mutation tests assert zero bank writes. | Production attestation policy, device governance, account recovery, and relying-party deployment are not implemented. |
| Duplicate debit after timeout/retry | Per-step idempotency keys; mock bank stores request hash and result; conflicting key reuse is rejected; lookup/reconciliation can recover an accepted effect without issuing a second write. | In-memory mock-bank idempotency does not represent a production bank's retention/SLA. PostgreSQL concurrency tests require an explicit disposable database. |
| Stale state or changed quote | Plan binds bank-state version and exact quote IDs/economics/expiry; pre-approval customer state must match; gateway revalidates state and remaining route; mock bank rejects unknown, expired, amount-altered, or price/fee-altered quotes. | Quotes are synthetic and short-lived. Multi-step state advances are handled, but external-market slippage/venue behavior is not modeled. |
| Hard constraint violated during a bundle | Compiler proves hard constraints and dependencies; execution simulates each step and remaining bundle; material changes require safe stop/reapproval; protected-balance failures are deterministic. | Multi-step writes are not atomic and no automatic compensation is claimed. A settled early step can remain after a later safe stop. |
| Insufficient funds, unavailable rail/asset, or bank-state change | Compiler feasibility checks plus gateway revalidation and mock-bank validation before mutation; errors fail closed and partial outcomes are explicit. | Failure scenarios are synthetic; real provider error taxonomies and operational runbooks remain out of scope. |
| High-risk or ineligible customer executes | Persisted synthetic KYC status; deterministic amount/velocity policy; risk assessment and reservation; execution-time risk gate can block or require review before bank write. | KYC is not backed by an external provider. The demo has policy thresholds, not a full fraud/AML platform. Step-up beyond the required passkey is represented as review rather than a second production factor. |
| Audit evidence is altered or unavailable | Durable workflow rows retain requests/drafts, semantic-validation evidence, hashes, plans, challenges, approval evidence, risk decisions, execution steps, bank references, snapshots, audit events, and an outbox. Ops Portal is read-only and redacts sensitive values. | Audit records are not externally notarized or WORM storage. Retention, export, SIEM integration, and regulatory controls are not implemented. |
| Redis/worker outage | PostgreSQL remains authoritative; Redis is non-authoritative; reconciliation uses persisted execution/idempotency evidence; safe local launcher excludes the worker. | Automatic recovery is intentionally not run by the safe demo stack. Operator-reviewed recovery procedures remain necessary. |
| Service outage or partial startup | `/health` and `/ready`; safe launcher validates owned process groups, ports, database isolation, bank-state restoration, and cleans up only children from its startup attempt. | This is local-process supervision, not production orchestration, HA, or disaster recovery. |
| Seed/catalog drift | Canonical demo grounding fixture is compared with the authoritative mock-bank beneficiary and asset catalog in a no-database regression test. | Existing databases with legacy IDs are not destructively rewritten; use a fresh disposable database or an explicitly reviewed migration. |

## Security verification

Run `pnpm security` for the isolated assurance scenarios and `pnpm test` for the broader unit/in-memory suite. Database-backed integration tests run only when `TEST_DATABASE_URL` is explicitly present; they never fall back to `DATABASE_URL`. The assurance runner deliberately strips database, TokenHub, Redis, compiler, and bank-service configuration from child processes.

Key enforcement points include:

- `packages/intent-engine/src/validation/validator.ts`
- `packages/intent-engine/src/bundle/validator.ts`
- `apps/api/src/security/request-authorization.ts`
- `apps/api/src/webauthn/service.ts`
- `apps/api/src/execution/gateway.ts`
- `apps/api/src/orchestration/services.ts`
- `apps/api/src/risk/evaluator.ts`
- `services/mock-bank/src/app.ts`

The evidence demonstrates behavior of this source tree and its synthetic adapters. It must not be presented as proof of real-bank deployment, guaranteed AI accuracy, external KYC, penetration-test completion, or regulatory compliance.
