import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync(new URL("../prisma/review-migration-policy.mjs", import.meta.url), "utf8");
const { approvedMigrationState } = await import(`data:text/javascript,${encodeURIComponent(source)}`) as { approvedMigrationState(applied: string[], expected: string[], environment: Record<string, string>): boolean };
const expected = ["existing", "20261016000000_synthetic_bank_operation_ledger"];
const review = { PARLANCE_PUBLIC_SAFE_MODE: "true", PARLANCE_BANK_DATABASE_SNAPSHOT: "true" };
it("accepts the known pre-ledger schema only for read-only review without migrations", () => {
  expect(approvedMigrationState(["existing"], expected, review)).toBe(true);
  expect(approvedMigrationState([], expected, review)).toBe(false);
  expect(approvedMigrationState(["unexpected"], expected, review)).toBe(false);
  expect(approvedMigrationState(expected, expected, {})).toBe(true);
});
it.each(["PARLANCE_BANK_DURABLE_EXECUTION", "PARLANCE_PUBLIC_PASSKEY_EXECUTION_ENABLED", "PARLANCE_SYNTHETIC_DB_MIGRATIONS_ALLOWED"])("requires the ledger when %s is enabled", (flag) => {
  expect(approvedMigrationState(["existing"], expected, { ...review, [flag]: "true" })).toBe(false);
});
it("rejects a missing ledger outside explicitly safe snapshot review", () => {
  expect(approvedMigrationState(["existing"], expected, {})).toBe(false);
});
