import { BankStateSnapshotV1 } from "@parlance/contracts";
import { getPrismaClient } from "@parlance/db";

// In the isolated Railway demo, PostgreSQL owns the customer catalogue and
// balances. The mock bank supplies illustrative quotes but cannot execute.
export async function databaseCustomerSnapshot(userId: string) {
  const db = getPrismaClient();
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    const error = new Error("CUSTOMER_NOT_FOUND") as Error & { statusCode: number };
    error.statusCode = 404;
    throw error;
  }
  const [accounts, beneficiaries, holdings, assets] = await Promise.all([
    db.account.findMany({ where: { userId, status: "ACTIVE" }, orderBy: { currency: "asc" } }),
    db.beneficiary.findMany({ where: { userId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
    db.holding.findMany({ where: { userId }, orderBy: { assetId: "asc" } }),
    db.asset.findMany({ where: { tradable: true }, orderBy: { symbol: "asc" } }),
  ]);
  const stateVersion = Math.max(0, ...accounts.map((item) => item.stateVersion), ...holdings.map((item) => item.stateVersion));
  const assetQuotes = assets.filter((item) => item.symbol === "AAPL").map((item) => ({
    quoteId: "asset-quote-aapl-usd-v1", assetId: item.id, settlementCurrency: "USD",
    unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00.000Z",
  }));
  return BankStateSnapshotV1.parse({
    schemaVersion: "1", userId, stateVersion, capturedAt: new Date().toISOString(),
    accounts: accounts.map((item) => ({
      id: item.id, type: item.type, currency: item.currency, ledgerMinorUnits: item.ledgerMinorUnits.toString(),
      availableMinorUnits: item.availableMinorUnits.toString(), status: item.status, capabilities: item.capabilities,
    })),
    beneficiaries: beneficiaries.map((item) => ({
      id: item.id, name: item.name, supportedCurrencies: item.supportedCurrencies, status: item.status,
    })),
    assets: assets.map((item) => ({
      id: item.id, symbol: item.symbol, name: item.name, assetType: item.assetType,
      tradable: item.tradable, settlementCurrency: item.settlementCurrency,
    })),
    holdings: holdings.map((item) => ({ assetId: item.assetId, quantity: item.quantity.toString() })),
    obligations: [],
    serviceAvailability: { transfers: false, fx: true, billPayments: false, investments: true },
    fxQuotes: [], assetQuotes,
  });
}
