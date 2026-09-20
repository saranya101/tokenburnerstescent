# Architecture

Parlance separates language interpretation from financial authority:

```text
human language -> untrusted IntentDraft -> grounding / ambiguity resolution
-> user-confirmed GoalContract -> deterministic Python compiler
-> policy and preflight -> exact FinancialPlan -> user approval
-> Execution Gateway -> mocked bank APIs -> refresh / revalidation
-> reconciliation and append-oriented audit
```

AI interprets language into goals and constraints. It cannot construct `FinancialPlanStep` values and has no bank-write client. The deterministic compiler is the sole component that constructs financial actions. The Execution Gateway is the only path to banking writes and verifies confirmation, approval binding, freshness, operation allowlisting, idempotency and valid state before dispatch.

PostgreSQL is authoritative for goals, approvals, execution state, idempotency, audit and the transactional outbox. Redis provides only cache, rate limiting, queues, short-lived coordination and non-authoritative UI trace delivery. Financial correctness must survive a total Redis loss.

pgvector lives inside PostgreSQL and retrieves candidate context or entity matches only. A semantic match cannot confirm an entity, authorize a transaction or satisfy a policy check.

## Services

- `apps/web`: user and operator shell; consumes API and future SSE trace events.
- `apps/api`: orchestration, durable workflow boundaries and Execution Gateway.
- `apps/worker`: BullMQ consumers for reconciliation and asynchronous work.
- `services/compiler`: deterministic planning, constraints, policies and explanations; never calls an LLM.
- `services/mock-bank`: deterministic development bank with idempotent writes and failure scenarios.

## Readiness

`/health` means the process is alive. `/ready` means required runtime configuration/dependencies are available. The API deliberately reports not-ready when its required URLs are absent. Future adapters should actively probe PostgreSQL, Redis, compiler and bank dependencies.
