# Initial threat model

| Threat | Initial control | Follow-up |
|---|---|---|
| Prompt injection | Model output is untrusted, goal-only and Zod-validated; no write client | Add adversarial corpus and strict tool sandbox |
| Duplicate execution | Required idempotency key; durable unique key in PostgreSQL | Specify scopes, retention and request-hash conflict behavior |
| Stale bank state | Approval binds `stateVersion`; gateway requires match/revalidation | Implement per-step refresh and policy-aware replan |
| Wrong entity resolution | Semantic retrieval returns candidates only | Require explicit confirmation for uncertain/sensitive entities |
| Ambiguous beneficiary | Goal can enter `AWAITING_CLARIFICATION` | Define thresholds and UI confirmation copy |
| Quote expiry | Approval expiry and revalidation hook | Bind quote ID/expiry into plan and preflight |
| Partial failure | Execution steps and reconciliation states | Define compensation and manual-review runbooks |
| Service outage | Honest readiness; retryable durable outbox | Add bounded retry/circuit-breaker policies |
| Redis outage | PostgreSQL remains truth; Redis is disposable | Test recovery with lost queues/cache/pub-sub |
| Compiler failure | Typed error/UNSAT result; no fallback to LLM planning | Add deterministic replay, timeouts and diagnostics |

The scaffold is not a production security claim. Cryptographic/biometric approval evidence, authorization, secrets management, data retention, privacy controls and provider authentication remain explicit TODOs.
