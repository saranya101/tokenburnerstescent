import { expect, it, vi } from "vitest";

vi.mock("@parlance/db", () => ({ getPrismaClient: () => ({
  user: { findUnique: async ({ where }: { where: { id: string } }) => where.id === "synthetic-customer" ? { id: where.id } : null },
  account: { findMany: async () => [
    { id: "acc-sgd", type: "CHECKING", currency: "SGD", ledgerMinorUnits: 2_000_000n, availableMinorUnits: 2_000_000n, status: "ACTIVE", capabilities: ["SEND_TRANSFER"], stateVersion: 7 },
    { id: "acc-usd", type: "CHECKING", currency: "USD", ledgerMinorUnits: 500_000n, availableMinorUnits: 500_000n, status: "ACTIVE", capabilities: ["TRADE_ASSET"], stateVersion: 7 },
  ] },
  beneficiary: { findMany: async () => [{ id: "ben-john-lim", name: "John Lim", supportedCurrencies: ["SGD"], status: "ACTIVE" }] },
  holding: { findMany: async () => [{ assetId: "asset-aapl", quantity: { toString: () => "2" }, stateVersion: 7 }] },
  asset: { findMany: async () => [{ id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY", tradable: true, settlementCurrency: "USD" }] },
}) }));

import { databaseCustomerSnapshot } from "./database-snapshot.js";

it("reads the customer's persisted accounts, payees, and investment holdings", async () => {
  const state = await databaseCustomerSnapshot("synthetic-customer");
  expect(state).toMatchObject({
    userId: "synthetic-customer", stateVersion: 7,
    accounts: [
      { id: "acc-sgd", currency: "SGD", availableMinorUnits: "2000000" },
      { id: "acc-usd", currency: "USD", availableMinorUnits: "500000" },
    ],
    beneficiaries: [{ id: "ben-john-lim", name: "John Lim" }],
    holdings: [{ assetId: "asset-aapl", quantity: "2" }],
    assetQuotes: [{ assetId: "asset-aapl", settlementCurrency: "USD" }],
  });
  await expect(databaseCustomerSnapshot("other-customer")).rejects.toMatchObject({ statusCode: 404 });
});
