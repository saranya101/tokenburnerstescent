import type { PrismaClient } from "@parlance/db";
import { expect, it, vi } from "vitest";
import { PrismaEntityGrounder } from "./prisma-grounder.js";

function database(
  accounts: Array<{ providerRef: string; type: string; currency: string; availableMinorUnits: bigint }>,
  aliases: Array<{ entityType: string; entityId: string; alias: string }>,
  beneficiaries: Array<{ providerRef: string; name: string }> = [],
  assets: Array<{ id: string; name: string; symbol: string }> = [],
) {
  return {
    account: { findMany: vi.fn().mockResolvedValue(accounts) },
    beneficiary: { findMany: vi.fn().mockResolvedValue(beneficiaries) },
    asset: { findMany: vi.fn().mockResolvedValue(assets) },
    entityAlias: { findMany: vi.fn().mockResolvedValue(aliases) },
  } as unknown as PrismaClient;
}

const apple = { id: "asset-aapl", name: "Apple Inc.", symbol: "AAPL" };

it.each([
  ["Buy 1 share of Apple.", "Apple"],
  ["Buy 1 share of AAPL.", "AAPL"],
  ["Buy 1 share of Apple Inc.", "Apple Inc."],
  ["Buy 1 share of Apple (AAPL).", "Apple (AAPL)"],
])("resolves the supported asset in %s through the production catalog grounder", async (_instruction, reference) => {
  const db = database([], [{ entityType: "ASSET", entityId: apple.id, alias: "Apple" }], [], [apple]);

  await expect(new PrismaEntityGrounder(db, "customer-1").ground({ reference, expectedEntityType: "ASSET" })).resolves.toMatchObject({
    status: "RESOLVED", entityType: "ASSET", entityId: apple.id,
  });
});

it("does not invent an unknown asset", async () => {
  const db = database([], [{ entityType: "ASSET", entityId: apple.id, alias: "Apple" }], [], [apple]);

  await expect(new PrismaEntityGrounder(db, "customer-1").ground({ reference: "Imaginary Labs (IMAG)", expectedEntityType: "ASSET" })).resolves.toEqual({
    status: "NOT_FOUND", reference: "Imaginary Labs (IMAG)", expectedEntityType: "ASSET",
  });
});

it("does not treat an orphaned asset alias as an authoritative catalog asset", async () => {
  const db = database([], [{ entityType: "ASSET", entityId: "asset-missing", alias: "Imaginary Labs" }]);

  await expect(new PrismaEntityGrounder(db, "customer-1").ground({ reference: "Imaginary Labs", expectedEntityType: "ASSET" })).resolves.toEqual({
    status: "NOT_FOUND", reference: "Imaginary Labs", expectedEntityType: "ASSET",
  });
});

it("keeps genuinely ambiguous asset aliases ambiguous", async () => {
  const assets = [apple, { id: "asset-apple-hospitality", name: "Apple Hospitality REIT", symbol: "APLE" }];
  const db = database([], [
    { entityType: "ASSET", entityId: apple.id, alias: "Apple" },
    { entityType: "ASSET", entityId: "asset-apple-hospitality", alias: "Apple" },
  ], [], assets);

  await expect(new PrismaEntityGrounder(db, "customer-1").ground({ reference: "Apple", expectedEntityType: "ASSET" })).resolves.toMatchObject({
    status: "AMBIGUOUS",
    candidates: [
      { entityId: "asset-aapl", canonicalName: "Apple Inc." },
      { entityId: "asset-apple-hospitality", canonicalName: "Apple Hospitality REIT" },
    ],
  });
});

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
  expect(db.beneficiary.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "customer-1", status: "ACTIVE", providerRef: { not: null } } }));
});

it("keeps two customer-owned John aliases ambiguous while resolving an exact full name", async () => {
  const db = database(
    [],
    [
      { entityType: "BENEFICIARY", entityId: "ben-john-tan", alias: "John" },
      { entityType: "BENEFICIARY", entityId: "ben-john-lim", alias: "John" },
    ],
    [
      { providerRef: "ben-john-tan", name: "John Tan" },
      { providerRef: "ben-john-lim", name: "John Lim" },
    ],
  );
  const grounder = new PrismaEntityGrounder(db, "customer-1");
  await expect(grounder.ground({ reference: "John", expectedEntityType: "BENEFICIARY" })).resolves.toMatchObject({
    status: "AMBIGUOUS", candidates: [
      { entityId: "ben-john-lim", canonicalName: "John Lim" },
      { entityId: "ben-john-tan", canonicalName: "John Tan" },
    ],
  });
  await expect(grounder.ground({ reference: "John Tan", expectedEntityType: "BENEFICIARY" })).resolves.toMatchObject({
    status: "RESOLVED", entityId: "ben-john-tan", resolutionMethod: "EXACT",
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
