import { describe, expect, it } from "vitest";
import { describeCandidate, holdingValue, money, quotedPortfolioValues, sgdReserveMinorUnits } from "./presentation";

describe("banking display values", () => {
  it("preserves large balances without floating point loss", () => expect(money("SGD", "900719925474099300")).toBe("S$9,007,199,254,740,993.00"));
  it("values fractional holdings in the quote currency's minor units", () => expect(money("USD", holdingValue("1.25", "20000"))).toBe("US$250.00"));
  it("adds only fresh server quotes into a currency-specific estimate", () => {
    const totals = quotedPortfolioValues([
      { assetId: "a", quantity: "1" }, { assetId: "b", quantity: "2" }, { assetId: "c", quantity: "5" },
    ], [
      { assetId: "a", settlementCurrency: "USD", unitPriceMinor: "20000", expiresAt: "2099-01-01T00:00:00Z" },
      { assetId: "b", settlementCurrency: "USD", unitPriceMinor: "10000", expiresAt: "2099-01-01T00:00:00Z" },
      { assetId: "c", settlementCurrency: "SGD", unitPriceMinor: "5000", expiresAt: "2099-01-01T00:00:00Z" },
    ], Date.parse("2026-10-14T00:00:00Z"));
    expect(totals).toEqual([{ currency: "USD", minorUnits: "40000" }, { currency: "SGD", minorUnits: "25000" }]);
    expect(quotedPortfolioValues([{ assetId: "c", quantity: "5" }], [{ assetId: "c", settlementCurrency: "SGD", unitPriceMinor: "5000", expiresAt: "2020-01-01T00:00:00Z" }], Date.parse("2026-10-14T00:00:00Z"))).toEqual([]);
  });
  it("parses an exact optional SGD reserve without floating point rounding", () => {
    expect(sgdReserveMinorUnits("1,000.00")).toBe("100000");
    expect(sgdReserveMinorUnits("0.5")).toBe("50");
    expect(sgdReserveMinorUnits("1.234")).toBeUndefined();
    expect(sgdReserveMinorUnits("-1")).toBeUndefined();
  });
  it("shows both goals, the hard reserve and conditional funding before meaning confirmation", () => {
    expect(describeCandidate({ items: [
      { goal: { type: "DELIVER_MONEY", amount: { currency: "SGD", minorUnits: "10000" }, recipientReference: "John Lim" } },
      { goal: { type: "ACQUIRE_ASSET", quantity: "1", assetReference: "Apple" }, preferences: [{ type: "PREFER_ACCOUNT", accountReference: "my SGD account" }] },
    ], globalConstraints: [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "100000" }, accountReference: "my SGD account" }] })).toEqual([
      "1. Send S$100.00 to John Lim", "2. Buy 1 Apple", "Keep at least S$1,000.00 available in my SGD account", "Prefer my SGD account for funding if needed",
    ]);
  });
});
