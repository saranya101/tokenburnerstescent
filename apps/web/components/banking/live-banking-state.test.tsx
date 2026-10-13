import { BankStateSnapshotV1, CustomerActivityV1 } from "@parlance/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatMinorUnits } from "../../lib/banking-state";
import { AccountsView } from "./accounts-view";
import { BankingHomeView } from "./banking-home";
import { customerDesktopNavigation } from "./banking-nav";
import { ChatBankingSidebarView } from "../chat/chat-banking-sidebar";
import { InvestmentView } from "./investment-view";
import { matchingPayees, SavedPayeesView } from "./saved-payees-view";

const bankState = BankStateSnapshotV1.parse({
  schemaVersion: "1",
  userId: "demo-customer",
  stateVersion: 3,
  capturedAt: "2026-10-03T00:00:00.000Z",
  accounts: [
    { id: "acc-sgd", type: "CHECKING", currency: "SGD", ledgerMinorUnits: "2000000", availableMinorUnits: "2000000", status: "ACTIVE", capabilities: ["SEND_TRANSFER", "RECEIVE_TRANSFER"] },
    { id: "acc-usd", type: "BROKERAGE", currency: "USD", ledgerMinorUnits: "449900", availableMinorUnits: "449900", status: "ACTIVE", capabilities: ["SEND_TRANSFER", "TRADE_ASSET"] },
  ],
  beneficiaries: [
    { id: "ben-john-tan", name: "John Tan", supportedCurrencies: ["SGD"], status: "ACTIVE" },
    { id: "ben-john-lim", name: "John Lim", supportedCurrencies: ["SGD"], status: "ACTIVE" },
    { id: "ben-ntu", name: "Nanyang Technological University", supportedCurrencies: ["USD"], status: "ACTIVE" },
  ],
  assets: [{ id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY", tradable: true, settlementCurrency: "USD" }],
  holdings: [{ assetId: "asset-aapl", quantity: "1" }],
  obligations: [],
  serviceAvailability: { transfers: true, fx: true, billPayments: true, investments: true },
  fxQuotes: [],
  assetQuotes: [{ quoteId: "asset-quote-aapl-usd-v1", assetId: "asset-aapl", settlementCurrency: "USD", unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00.000Z" }],
});
const activity = CustomerActivityV1.parse({ items: [
  { occurredAt: "2026-10-03T10:00:00.000Z", description: "Transfer to John Tan", accountLabel: "USD Account", amount: { currency: "USD", minorUnits: "30000" }, direction: "DEBIT", status: "COMPLETED" },
  { occurredAt: "2026-10-03T10:01:00.000Z", description: "Buy 1 AAPL", accountLabel: "USD Account", amount: { currency: "USD", minorUnits: "20100" }, direction: "DEBIT", status: "COMPLETED" },
] });

describe("authoritative customer banking presentation", () => {
  it("formats integer minor units without floating-point arithmetic", () => {
    expect(formatMinorUnits("USD", "449900")).toBe("US$4,499.00");
  });

  it("shows the authoritative AAPL holding and quote-derived estimated value", () => {
    const html = renderToStaticMarkup(createElement(InvestmentView, { state: bankState, activity, loading: false }));
    expect(html).toContain("Apple Inc.");
    expect(html).toContain("1 share");
    expect(html).toContain("US$200.00");
    expect(html).toContain("100%");
    expect(html).toContain("S$20,000.00");
    expect(html).toContain("US$4,499.00");
    expect(html).toContain("Buy 1 AAPL");
    expect(html).toContain("Market watch");
    expect(html).toContain("Historical valuation data is not available");
    expect(html).not.toMatch(/daily gain|top gainers|most active|US\$201\.24/iu);
    expect(html).toContain("not external market prices");
  });

  it("keeps the holding visible when no quote is available", () => {
    const state = BankStateSnapshotV1.parse({ ...bankState, assetQuotes: [] });
    const html = renderToStaticMarkup(createElement(InvestmentView, { state, loading: false }));
    expect(html).toContain("Apple Inc.");
    expect(html).toContain("1 share");
    expect(html).toContain("No fresh quote");
    expect(html).toContain("Current value</dt><dd>Unavailable");
  });

  it("treats an expired quote as unavailable instead of valuing the portfolio", () => {
    const state = BankStateSnapshotV1.parse({ ...bankState, assetQuotes: [{ ...bankState.assetQuotes[0]!, expiresAt: "2026-10-02T23:59:59.000Z" }] });
    const html = renderToStaticMarkup(createElement(InvestmentView, { state, activity, loading: false }));
    expect(html).toContain("No fresh quote");
    expect(html).toContain("Quote unavailable");
    expect(html).not.toContain("US$200.00");
  });

  it("renders live account and investment summaries on Home", () => {
    const html = renderToStaticMarkup(createElement(BankingHomeView, { state: bankState, activity, loading: false }));
    expect(html).toContain("S$20,000.00");
    expect(html).toContain("US$4,499.00");
    expect(html).toContain("AAPL"); expect(html).toContain("1 share"); expect(html).toContain("US$200.00");
    expect(html).toContain("Transfer to John Tan"); expect(html).toContain("−US$300.00"); expect(html).toContain("−US$201.00");
    expect(html).not.toMatch(/24,830\.40|4,750\.00|S\$24,499\.00|Total balance|Monthly cashflow|Illustrative/u);
  });

  it("renders the chat banking rail only from authoritative account and activity data", () => {
    const html = renderToStaticMarkup(createElement(ChatBankingSidebarView, { state: bankState, activity, loading: false }));
    expect(html).toContain("Your accounts"); expect(html).toContain("S$20,000.00"); expect(html).toContain("US$4,499.00");
    expect(html).toContain("Recent transactions"); expect(html).toContain("Transfer to John Tan"); expect(html).toContain("−US$300.00");
    expect(html).not.toMatch(/Insights for you|Move money with confidence|Try asking about/iu);
  });

  it("shows the authoritative version-8 partial outcome without calling unsettled steps completed", () => {
    const partialState = BankStateSnapshotV1.parse({
      ...bankState,
      stateVersion: 8,
      accounts: bankState.accounts.map((account) => account.id === "acc-sgd"
        ? { ...account, ledgerMinorUnits: "190000", availableMinorUnits: "190000" }
        : { ...account, ledgerMinorUnits: "0", availableMinorUnits: "0" }),
      holdings: [{ assetId: "asset-aapl", quantity: "2" }],
    });
    const partialActivity = CustomerActivityV1.parse({ items: [{
      occurredAt: "2026-10-13T03:31:10.396Z", description: "Transfer to John Lim", accountLabel: "SGD Account",
      amount: { currency: "SGD", minorUnits: "10000" }, direction: "DEBIT", status: "COMPLETED", planOutcome: "PARTIALLY_COMPLETED",
    }] });
    const sidebar = renderToStaticMarkup(createElement(ChatBankingSidebarView, { state: partialState, activity: partialActivity, loading: false }));
    expect(sidebar).toContain("S$1,900.00");
    expect(sidebar).toContain("US$0.00");
    expect(sidebar).toContain("Transfer to John Lim");
    expect(sidebar).toContain("Settled · Part of a partially completed request");
    expect(sidebar).not.toContain("Buy 1 AAPL");

    const home = renderToStaticMarkup(createElement(BankingHomeView, { state: partialState, activity: partialActivity, loading: false }));
    expect(home).toContain("Settled · Partial request");
  });

  it("lists and searches authoritative saved payees without inventing recipient details", () => {
    const html = renderToStaticMarkup(createElement(SavedPayeesView, { state: bankState, loading: false }));
    expect(html).toContain("John Tan"); expect(html).toContain("John Lim"); expect(html).toContain("Nanyang Technological University");
    expect(html).toContain("SGD transfers"); expect(html).toContain("USD transfers");
    expect(html).toContain("draft=Send+money+to+John+Tan");
    expect(html).not.toMatch(/account number|••••|DBS Bank Ltd/iu);
    expect(matchingPayees(bankState.beneficiaries, "john").map((item) => item.name)).toEqual(["John Lim", "John Tan"]);
    expect(matchingPayees(bankState.beneficiaries, "missing")).toEqual([]);
  });

  it("renders honest saved-payee loading, empty, and error states", () => {
    expect(renderToStaticMarkup(createElement(SavedPayeesView, { loading: true }))).toContain("Loading your saved payees");
    expect(renderToStaticMarkup(createElement(SavedPayeesView, { loading: false, error: "CUSTOMER_STATE_UNAVAILABLE" }))).toContain("Saved payees are temporarily unavailable");
    const emptyState = BankStateSnapshotV1.parse({ ...bankState, beneficiaries: [] });
    expect(renderToStaticMarkup(createElement(SavedPayeesView, { state: emptyState, loading: false }))).toContain("No saved payees");
  });

  it("renders honest loading, empty, and error states in the chat banking rail", () => {
    const loading = renderToStaticMarkup(createElement(ChatBankingSidebarView, { loading: true }));
    expect(loading).toContain('aria-label="Loading your accounts"'); expect(loading).toContain('aria-label="Loading recent transactions"');
    const emptyState = BankStateSnapshotV1.parse({ ...bankState, accounts: [] });
    const emptyActivity = CustomerActivityV1.parse({ items: [] });
    const empty = renderToStaticMarkup(createElement(ChatBankingSidebarView, { state: emptyState, activity: emptyActivity, loading: false }));
    expect(empty).toContain("No accounts are available"); expect(empty).toContain("No completed transactions yet");
    const error = renderToStaticMarkup(createElement(ChatBankingSidebarView, { loading: false, error: "CUSTOMER_STATE_UNAVAILABLE" }));
    expect(error).toContain("Your accounts are temporarily unavailable"); expect(error).toContain("Recent transactions are temporarily unavailable");
  });

  it("renders Accounts from live state with separate balances and account details", () => {
    const html = renderToStaticMarkup(createElement(AccountsView, { state: bankState, loading: false }));
    expect(html).toContain("SGD Account"); expect(html).toContain("S$20,000.00");
    expect(html).toContain("USD Account"); expect(html).toContain("US$4,499.00");
    expect(html).toContain("Ledger balance"); expect(html).not.toMatch(/••••|24,830\.40/u);
  });

  it("renders a clean empty investment state", () => {
    const state = BankStateSnapshotV1.parse({ ...bankState, holdings: [] });
    const html = renderToStaticMarkup(createElement(InvestmentView, { state, loading: false }));
    expect(html).toContain("No investments yet");
    expect(html).toContain("Buy / Invest");
    expect(html).toContain("No holdings to allocate");
    expect(html).not.toMatch(/AI Insights|Portfolio Insights/iu);
  });

  it("links authoritative sections to dedicated customer pages", () => {
    expect(customerDesktopNavigation.find((item) => item.id === "home")?.href).toBe("/");
    expect(customerDesktopNavigation.find((item) => item.id === "accounts")?.href).toBe("/accounts");
    expect(customerDesktopNavigation.find((item) => item.id === "invest")?.href).toBe("/invest");
    expect(customerDesktopNavigation.find((item) => item.id === "parlance")?.href).toBe("/chat");
  });
});
