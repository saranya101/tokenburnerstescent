import type { PrismaClient } from "@parlance/db";
import { expect, it, vi } from "vitest";
import { PrismaEntityGrounder } from "./prisma-grounder.js";

function database(
  accounts: Array<{ providerRef: string; type: string; currency: string; availableMinorUnits: bigint }>,
  aliases: Array<{ entityType: string; entityId: string; alias: string }>,
  beneficiaries: Array<{ providerRef: string; name: string }> = [],
) {
  return {
    account: { findMany: vi.fn().mockResolvedValue(accounts) },
    beneficiary: { findMany: vi.fn().mockResolvedValue(beneficiaries) },
    asset: { findMany: vi.fn().mockResolvedValue([]) },
    entityAlias: { findMany: vi.fn().mockResolvedValue(aliases) },
  } as unknown as PrismaClient;
}

it("resolves the only active customer-owned SGD account with its customer-facing name", async () => {
  const db = database([
    { providerRef: "acc-sgd", type: "CHECKING", currency: "SGD", availableMinorUnits: 1_733_334n },
    { providerRef: "acc-usd", type: "WALLET", currency: "USD", availableMinorUnits: 500_000n },
  ], [{ entityType: "ACCOUNT", entityId: "acc-sgd", alias: "DBS Multiplier Account" }]);
  await expect(new PrismaEntityGrounder(db, "customer-1").ground({ reference: "my SGD account", expectedEntityType: "ACCOUNT" })).resolves.toMatchObject({ status: "RESOLVED", entityId: "acc-sgd" });
  expect(db.account.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "customer-1", status: "ACTIVE" } }));
});

it("resolves the seeded NTU alias to the canonical beneficiary", async () => {
  const db = database(
    [],
    [{ entityType: "BENEFICIARY", entityId: "ben-ntu", alias: "NTU" }],
    [{ providerRef: "ben-ntu", name: "Nanyang Technological University" }],
  );

  await expect(new PrismaEntityGrounder(db, "customer-1").ground({ reference: "NTU", expectedEntityType: "BENEFICIARY" })).resolves.toMatchObject({
    status: "RESOLVED", entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "ALIAS",
  });
});

it("returns real names and balances when more than one SGD account is eligible", async () => {
  const db = database([
    { providerRef: "acc-main", type: "CHECKING", currency: "SGD", availableMinorUnits: 1_733_334n },
    { providerRef: "acc-save", type: "SAVINGS", currency: "SGD", availableMinorUnits: 842_000n },
  ], [
    { entityType: "ACCOUNT", entityId: "acc-main", alias: "DBS Multiplier Account" },
    { entityType: "ACCOUNT", entityId: "acc-save", alias: "Savings Account" },
  ]);
  await expect(new PrismaEntityGrounder(db, "customer-1").ground({ reference: "my SGD account", expectedEntityType: "ACCOUNT" })).resolves.toMatchObject({ status: "AMBIGUOUS", candidates: [
    { entityId: "acc-main", canonicalName: "DBS Multiplier Account", account: { currency: "SGD", availableMinorUnits: "1733334" } },
    { entityId: "acc-save", canonicalName: "Savings Account", account: { currency: "SGD", availableMinorUnits: "842000" } },
  ] });
});
