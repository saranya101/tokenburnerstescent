# Parlance

Parlance is a trusted execution layer for agentic banking. This repository is an initial architecture scaffold: it establishes boundaries and runnable health checks without claiming production financial logic.

## Safety invariant

The LLM is untrusted. It may propose a validated `IntentDraftV1` containing goals, constraints, preferences, and references, but it cannot create transaction steps or write to banking APIs. Only the deterministic Python compiler creates a `FinancialPlanV1`; only the API Execution Gateway can dispatch an approved plan to a bank adapter.

## Prerequisites

- Node.js 24 and pnpm 11
- Python 3.12+
- Docker (for local Redis)
- A Neon PostgreSQL URL for persistence work

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

## Database bootstrap

Run `packages/db/prisma/bootstrap.sql` before Prisma migrations to enable pgvector, then use `pnpm --filter @parlance/db prisma:generate` and `prisma:validate`. Prisma represents the embedding as `Unsupported("vector(1536)")`; advanced vector indexes and similarity queries will require reviewed SQL. Vector matches are retrieval hints only.

## Current scope

Routes, contracts, state transitions, an idempotent mock bank, a deliberately narrow deterministic compiler example, queue definitions, UI placeholders, tests and documentation are present. Persistent orchestration, real authorization, bank integrations, robust planning, policy and reconciliation are TODOs—not simulated as complete.
