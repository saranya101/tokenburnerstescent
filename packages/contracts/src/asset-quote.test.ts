import { describe, expect, it } from "vitest";
import { AssetQuoteV1, FinancialPlanStepV1 } from "./index.js";

const quote = {
  quoteId: "asset-quote-aapl-usd-v1", assetId: "asset-aapl", settlementCurrency: "USD",
  unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00.000Z",
};

describe("AssetQuoteV1", () => {
  it("accepts integer-minor-unit authoritative quote data", () => expect(AssetQuoteV1.parse(quote)).toEqual(quote));
  it("rejects a negative unit price", () => expect(() => AssetQuoteV1.parse({ ...quote, unitPriceMinor: "-1" })).toThrow());
  it("rejects a negative fee", () => expect(() => AssetQuoteV1.parse({ ...quote, feeMinor: "-1" })).toThrow());
  it("rejects an empty quote ID", () => expect(() => AssetQuoteV1.parse({ ...quote, quoteId: "" })).toThrow());
});

it("requires the complete authoritative quote binding on BUY_ASSET", () => {
  const step = { id: "buy-aapl", sequence: 0, action: "BUY_ASSET", dependsOn: [], reversible: false, parameters: {
    sourceAccountId: "acc-usd", assetId: "asset-aapl", quantity: "2.25", maximumSpend: { currency: "USD", minorUnits: "50000" },
  } };
  expect(() => FinancialPlanStepV1.parse(step)).toThrow();
  expect(FinancialPlanStepV1.parse({ ...step, parameters: {
    ...step.parameters, quoteId: quote.quoteId, settlementCurrency: "USD", quotedUnitPriceMinor: "20000", quotedFeeMinor: "100", authorizedTotalMinor: "45100",
  } }).parameters).toMatchObject({ quoteId: quote.quoteId, authorizedTotalMinor: "45100" });
});
