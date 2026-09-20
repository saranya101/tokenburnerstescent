# Ownership

## Developer A — Product + Integration

Owns `apps/web`, `apps/api`, `apps/worker`, `services/mock-bank`, and `packages/observability`.

## Developer B — Language Intelligence

Owns `packages/intent-engine` and `evaluation/intent`.

## Developer C — Deterministic Financial Intelligence

Owns `services/compiler` and `evaluation/compiler`.

## Shared review

All developers review changes to `packages/contracts` and `packages/db`. Changes affecting approval binding, state versions, idempotency, audit semantics or service boundaries require cross-owner review. `evaluation/adversarial`, `evaluation/baseline`, `infra`, and cross-cutting documentation should be coordinated across owners.
