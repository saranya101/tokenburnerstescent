import { BankStateSnapshotV1 } from "@parlance/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatMinorUnits } from "../../lib/banking-state";
import { BankingHomeView } from "./banking-home";
import { customerDesktopNavigation } from "./banking-nav";
import { InvestmentView } from "./investment-view";

const bankState = BankStateSnapshotV1.parse({
  schemaVersion: "1",
  userId: "demo-customer",
  stateVersion: 3,
  capturedAt: "2026-10-03T00:00:00.000Z",
  accounts: [
    { id: "acc-sgd", type: "CHECKING", currency: "SGD", ledgerMinorUnits: "2000000", availableMinorUnits: "2000000", status: "ACTIVE", capabilities: ["SEND_TRANSFER", "RECEIVE_TRANSFER"] },
    { id: "acc-usd", type: "BROKERAGE", currency: "USD", ledgerMinorUnits: "449900", availableMinorUnits: "449900", status: "ACTIVE", capabilities: ["SEND_TRANSFER", "TRADE_ASSET"] },
  ],
  beneficiaries: [],
  assets: [{ id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY", tradable: true, settlementCurrency: "USD" }],
  holdings: [{ assetId: "asset-aapl", quantity: "1" }],
  obligations: [],
  serviceAvailability: { transfers: true, fx: true, billPayments: true, investments: true },
  fxQuotes: [],
  assetQuotes: [{ quoteId: "asset-quote-aapl-usd-v1", assetId: "asset-aapl", settlementCurrency: "USD", unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00.000Z" }],
});

describe("authoritative customer banking presentation", () => {
  it("formats integer minor units without floating-point arithmetic", () => {
    expect(formatMinorUnits("USD", "449900")).toBe("US$4,499.00");
  });

  it("shows the authoritative AAPL holding and quote-derived estimated value", () => {
    const html = renderToStaticMarkup(createElement(InvestmentView, { state: bankState, loading: false }));
    expect(html).toContain("Apple Inc.");
    expect(html).toContain("1 AAPL");
    expect(html).toContain("US$200.00");
  });

  it("keeps the holding visible when no quote is available", () => {
    const state = BankStateSnapshotV1.parse({ ...bankState, assetQuotes: [] });
    const html = renderToStaticMarkup(createElement(InvestmentView, { state, loading: false }));
    expect(html).toContain("Apple Inc.");
    expect(html).toContain("1 AAPL");
    expect(html).toContain("No current demo bank quote is available");
  });

  it("renders live account and investment summaries on Home", () => {
    const html = renderToStaticMarkup(createElement(BankingHomeView, { state: bankState, loading: false }));
    expect(html).toContain("S$20,000.00");
    expect(html).toContain("US$4,499.00");
    expect(html).toContain("1 AAPL");
    expect(html).not.toMatch(/24,830\.40|4,750\.00/u);
    expect(html).toContain("Trend, cashflow, and recent activity remain illustrative");
  });

  it("links authoritative sections to dedicated customer pages", () => {
    expect(customerDesktopNavigation.find((item) => item.id === "home")?.href).toBe("/");
    expect(customerDesktopNavigation.find((item) => item.id === "accounts")?.href).toBe("/accounts");
    expect(customerDesktopNavigation.find((item) => item.id === "invest")?.href).toBe("/invest");
    expect(customerDesktopNavigation.find((item) => item.id === "parlance")?.href).toBe("/chat");
  });
});
