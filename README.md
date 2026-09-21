# Parlance

Parlance is a trusted execution layer for agentic banking. This repository is an initial architecture scaffold: it establishes boundaries and runnable health checks without claiming production financial logic.

## Safety invariant

The LLM is untrusted. It may propose a validated `IntentDraftV1` containing goals, constraints, preferences, and references, but it cannot create transaction steps or write to banking APIs. Only the deterministic Python compiler creates a `FinancialPlanV1`; only the API Execution Gateway can dispatch an approved plan to a bank adapter.

## Prerequisites

- Node.js 24 and pnpm 11
- Python 3.12+
- Docker (optional, for local Redis)
- PostgreSQL with the `vector` extension

Copy `.env.example` to `.env` and fill required values. For local-only database tests, any PostgreSQL instance with the `vector` extension can substitute for Neon; set both `DATABASE_URL` and `DIRECT_URL`. No PostgreSQL container is required by this scaffold.

## Install

```bash
pnpm install
python3 -m venv services/compiler/.venv
services/compiler/.venv/bin/pip install -e 'services/compiler[dev]'
```

## Run

```bash
docker compose -f infra/docker-compose.yml up -d  # Redis
pnpm --filter @parlance/web dev                   # http://localhost:3000
pnpm --filter @parlance/api dev                   # http://localhost:4001
pnpm --filter @parlance/mock-bank dev             # http://localhost:4002
pnpm --filter @parlance/worker dev                # http://localhost:4003
pnpm compiler:dev                                 # http://localhost:8001
```

`pnpm dev` runs all workspace development tasks through Turborepo. Root `build`, `lint`, `typecheck`, and `test` commands cover TypeScript; lint/test also cover Python. Each runnable service exposes `/health`; services with dependencies also expose `/ready` and must not claim readiness when configuration is missing.

## Database configuration and migrations

`DATABASE_URL` is the pooled application connection, `DIRECT_URL` is the direct migration connection, and `TEST_DATABASE_URL` must identify a dedicated disposable test database. Integration tests never fall back to `DATABASE_URL` and skip when `TEST_DATABASE_URL` is absent.

The baseline migration enables pgvector and establishes the current schema. Review the destination before applying it; never run reset or development migrations against shared/production data:

```bash
pnpm --filter @parlance/db prisma:generate
pnpm --filter @parlance/db prisma:validate
pnpm --filter @parlance/db prisma:deploy
```

### Baseline safety

For a fresh or disposable database, applying the baseline with `prisma migrate deploy` is appropriate. If an existing database already contains the baseline schema, do **not** deploy the baseline blindly: verify that its schema matches first, then mark the migration as already applied before deploying later migrations:

```bash
pnpm --filter @parlance/db exec prisma migrate resolve --applied 20260921000000_baseline
```

Never use `prisma migrate reset` on shared, production, or otherwise non-disposable databases. Integration tests must use `TEST_DATABASE_URL` only and must never fall back to `DATABASE_URL`.

For a dedicated test database, explicitly point both Prisma URLs at that database, deploy migrations, then run the integration test:

```bash
DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" pnpm --filter @parlance/db prisma:deploy
TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @parlance/api exec vitest run src/repositories/prisma.integration.test.ts
```

The restart test disconnects its first Prisma client, creates a new client/repository, and reconstructs the approval, execution, steps, audit, and outbox records. Redis and process memory are not used for reconstruction.

Outbox delivery uses expiring database leases (`claimedAt` plus `claimToken`). Only the current token can publish or release a row, and an expired `PROCESSING` lease can be reclaimed. Reconciliation classifies persisted steps only from bank-verifiable evidence; it does not retry financial writes.

## Current scope

Persistent orchestration, restart reconstruction, leased outbox processing, an idempotent mock bank, and reconciliation classification are present. Cryptographic authorization, real bank integrations, automatic recovery decisions, outbox transport, robust replanning, and production policy remain intentionally mocked or deferred.
