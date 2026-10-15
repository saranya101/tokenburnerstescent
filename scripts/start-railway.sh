#!/usr/bin/env bash
set -euo pipefail

cd /app
: "${DATABASE_URL:?DATABASE_URL must reference persistent PostgreSQL}"
: "${DIRECT_URL:?DIRECT_URL must reference persistent PostgreSQL}"
: "${PARLANCE_INTERNAL_API_TOKEN:?internal API credential required}"
: "${PARLANCE_BANK_API_TOKEN:?mock-bank credential required}"
if [[ "${PARLANCE_SYNTHETIC_DB_MIGRATIONS_ALLOWED:-false}" == "true" ]]; then
  node -e 'const u = new URL(process.env.DIRECT_URL); if (u.hostname !== "postgres.railway.internal") process.exit(1)'
  pnpm --filter @parlance/db prisma:deploy
fi
if [[ "${PARLANCE_ISOLATED_SYNTHETIC_INSPECT:-false}" == "true" ]]; then
  node packages/db/prisma/railway-isolated-synthetic.mjs --inspect
fi
if [[ "${PARLANCE_ISOLATED_SYNTHETIC_SEED_APPROVED:-false}" == "true" ]]; then
  node packages/db/prisma/railway-isolated-synthetic.mjs --seed
fi

export API_URL=http://127.0.0.1:4001
export COMPILER_URL=http://127.0.0.1:8001
export MOCK_BANK_URL=http://127.0.0.1:4002
web_port="${PORT:-8080}"

PORT=4002 node services/mock-bank/dist/server.js &
bank_pid=$!
PORT=4001 node apps/api/dist/server.js &
api_pid=$!
( cd services/compiler && exec python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 ) &
compiler_pid=$!
( cd apps/web && exec node node_modules/next/dist/bin/next start -H 0.0.0.0 -p "$web_port" ) &
web_pid=$!

stop_all() {
  trap - TERM INT EXIT
  kill "$bank_pid" "$api_pid" "$compiler_pid" "$web_pid" 2>/dev/null || true
  wait "$bank_pid" "$api_pid" "$compiler_pid" "$web_pid" 2>/dev/null || true
}
trap stop_all TERM INT EXIT
wait -n "$bank_pid" "$api_pid" "$compiler_pid" "$web_pid"
exit 1
