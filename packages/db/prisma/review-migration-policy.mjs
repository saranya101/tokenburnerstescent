// The ledger is not required for read-only synthetic snapshots. Never accept other gaps.
export function approvedMigrationState(applied, expected, environment) {
  if (JSON.stringify(applied) === JSON.stringify(expected)) return true;
  const reviewOnly = environment.PARLANCE_PUBLIC_SAFE_MODE === "true"
    && environment.PARLANCE_BANK_DATABASE_SNAPSHOT === "true"
    && environment.PARLANCE_BANK_DURABLE_EXECUTION !== "true"
    && environment.PARLANCE_PUBLIC_PASSKEY_EXECUTION_ENABLED !== "true"
    && environment.PARLANCE_SYNTHETIC_DB_MIGRATIONS_ALLOWED !== "true";
  const withoutLedger = expected.filter((name) => name !== "20261016000000_synthetic_bank_operation_ledger");
  return reviewOnly && JSON.stringify(applied) === JSON.stringify(withoutLedger);
}
