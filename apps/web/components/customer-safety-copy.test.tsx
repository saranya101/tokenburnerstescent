import { BankStateSnapshotV1, ExecutionResultV1 } from "@parlance/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlanPresentation } from "../lib/customer-presentation";
import { customerDesktopNavigation, customerMobileNavigation } from "./banking/banking-nav";
import { BankingHomeView } from "./banking/banking-home";
import { BankingShell } from "./banking/banking-shell";
import { chatWelcomeGreeting } from "./chat/chat-experience";
import { ConversationComposer } from "./chat/conversation-composer";
import { SingaporeSkyline } from "./chat/singapore-skyline";
import { ReapprovalCard } from "./execution/reapproval-card";
import { RecoveryStatusCard } from "./execution/recovery-status-card";
import { SafeStopCard } from "./execution/safe-stop-card";
import { PartialCompletionCard } from "./execution/partial-completion-card";
import { ExecutionTimeline } from "./execution/execution-timeline";
import { ClarificationCard } from "./goal/clarification-card";
import { UnderstoodGoalCard } from "./goal/understood-goal-card";
import { UnderstoodBundleCard } from "./goal/understood-bundle-card";
import { FinancialPlanPreview } from "./plan/financial-plan-preview";
import { RiskOutcomeCard } from "./risk/risk-outcome-card";

const scenario: PlanPresentation = {
  goal: { eyebrow: "Send money", title: "Send USD 70.00 to Nanyang Technological University", description: "Send money", details: [{ label: "Amount", value: "USD 70.00" }, { label: "To", value: "Nanyang Technological University" }], constraints: [], preferences: [] },
  planTitle: "Review payment details", planSummary: "Latest account information checked", funding: [{ account: "DBS Multiplier Account", amount: "SGD 26.66", detail: "Converted to USD" }], preservedConstraints: [],
  steps: [{ id: "send", kind: "Payment", title: "Send USD 70.00", summary: "USD Account to Nanyang Technological University", meta: [] }],
};

const investmentScenario: PlanPresentation = {
  goal: { eyebrow: "Buy an investment", title: "Buy 1 Apple share", description: "Check what you asked us to buy.", details: [{ label: "Investment", value: "Apple" }, { label: "Quantity", value: "1" }], constraints: [], preferences: [] },
  planTitle: "Review investment details", planSummary: "Latest account information checked", funding: [], preservedConstraints: [],
  steps: [{ id: "buy", kind: "Buy", title: "1 Apple", summary: "USD Account → Investment holding", meta: [] }],
};

it("presents the conversational route as Pay & Transfer in desktop and mobile banking navigation", () => {
  expect(customerDesktopNavigation.find((item) => item.href === "/chat")?.label).toBe("Pay & Transfer");
  expect(customerDesktopNavigation.find((item) => item.href === "/payees")?.label).toBe("Saved payees");
  expect(customerMobileNavigation.find((item) => item.href === "/chat")?.label).toBe("Pay & Transfer");
  expect(customerDesktopNavigation.map((item) => item.label)).not.toContain("Parlance");
});

it("prefills a saved-payee draft without submitting or authorizing it", () => {
  const onSubmit = vi.fn();
  const html = renderToStaticMarkup(createElement(ConversationComposer, { initialValue: "Send money to John Tan", onSubmit }));
  expect(html).toContain("Send money to John Tan");
  expect(html).toContain("Nothing moves without your approval");
  expect(onSubmit).not.toHaveBeenCalled();
});

it("scopes the dark wealth navigation to the Investments shell", () => {
  const investments = renderToStaticMarkup(createElement(BankingShell, { active: "invest", children: createElement("div") }));
  const home = renderToStaticMarkup(createElement(BankingShell, { active: "home", children: createElement("div") }));
  expect(investments).toContain("is-invest-shell");
  expect(home).not.toContain("is-invest-shell");
});

it("renders a banking task entry instead of an AI prompt gallery", () => {
  const html = renderToStaticMarkup(createElement(ConversationComposer, { onSubmit: vi.fn() }));
  expect(html).toContain("Describe a payment, transfer or investment");
  expect(html).not.toMatch(/Try asking about|Send money|Pay a bill|Buy an investment/iu);
  expect(html).not.toMatch(/Ask Parlance|AI helps|prompt/iu);
  expect(html).toContain("Use microphone for voice input");
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("Voice input");
});

it("renders the supplied Singapore skyline image without the previous inline SVG", () => {
  const html = renderToStaticMarkup(createElement(SingaporeSkyline));
  expect(html).toContain("/images/singapore-skyline.png");
  expect(html).toContain('width="2172"');
  expect(html).toContain('height="724"');
  expect(html).not.toContain("<svg");
});

it("does not present a placeholder name or guessed time of day on the chat welcome state", () => {
  const shell = renderToStaticMarkup(createElement(BankingShell, { active: "parlance", children: createElement("div") }));
  expect(chatWelcomeGreeting).toBe("Welcome back.");
  expect(chatWelcomeGreeting).not.toMatch(/morning|afternoon|evening|Alex/iu);
  expect(shell).not.toMatch(/Alex Tan|>AT</u);
  expect(shell).toContain('aria-label="Customer profile"');
});

it("does not present a hardcoded time-of-day greeting or customer name on the Home page", () => {
  const html = renderToStaticMarkup(createElement(BankingHomeView, { loading: true }));
  expect(html).toContain("Welcome back");
  expect(html).not.toMatch(/Good morning|Good afternoon|Good evening|Good night|Alex/iu);
});

it.each([
  ["REVIEW", "Additional review required", "We need to review this transaction before it can continue. No money has moved."],
  ["BLOCK", "Transaction can’t continue", "We can’t complete this transaction under the current safety checks. No money has moved."],
] as const)("renders a safe %s outcome without passkey controls or internal codes", (decision, title, detail) => {
  const html = renderToStaticMarkup(createElement(RiskOutcomeCard, { decision, onDone: vi.fn() }));
  expect(html).toContain(title);
  expect(html).toContain(detail);
  expect(html).toContain("Done");
  expect(html).not.toMatch(/passkey|RISK_REVIEW_REQUIRED|RISK_BLOCKED|DBS policy/iu);
});

it("defines distinct tablet and mobile shell behavior", () => {
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  expect(css).toContain("@media (min-width:768px) and (max-width:1199px)");
  expect(css).toMatch(/@media \(max-width:767px\)[\s\S]*?\.banking-sidebar \{ display:none; \}/u);
  expect(css).toContain("grid-template-columns:1fr");
});

function stopped(reason: string) {
  return ExecutionResultV1.parse({
    schemaVersion: "1", executionId: "execution", planId: "plan", status: "UNKNOWN", startedStateVersion: 7, finalStateVersion: 7,
    steps: [{ stepId: "send", status: "UNKNOWN", idempotencyKey: "idempotency", errorCode: reason }],
    goalOutcome: { achieved: false, summary: "Internal explanation" },
  });
}

function pendingConfirmation(status: "ACCEPTED" | "SETTLED", reason: string) {
  return ExecutionResultV1.parse({
    schemaVersion: "1", executionId: "execution", planId: "plan", status: "UNKNOWN", startedStateVersion: 7, finalStateVersion: 8,
    steps: [{ stepId: "send", status, idempotencyKey: "idempotency", bankReference: "bank-reference", errorCode: reason }],
    goalOutcome: { achieved: false, summary: "Confirmation pending." },
  });
}

describe("SafeStopCard", () => {
  it.each([
    ["GOAL_CONSTRAINT_VIOLATION", "Could not verify this step safely"],
    ["QUOTE_EXPIRED", "The exchange quote is no longer valid"],
    ["FX_UNAVAILABLE", "Currency conversion is currently unavailable"],
  ])("renders precise copy for %s", (reason, message) => {
    const props = { scenario, result: stopped(reason), onDone: vi.fn(), onStartOver: vi.fn(), onCheckStatus: vi.fn(), onShowRouteChange: vi.fn() };
    const html = renderToStaticMarkup(createElement(SafeStopCard, props));
    expect(html).toContain(message);
    expect(html).not.toContain("No longer available");
    expect(html).toContain("Payment stopped safely");
    expect(html).toContain("No unapproved action will continue");
  });
  it("does not claim failure or invite retry while the bank outcome is unknown", () => {
    const html = renderToStaticMarkup(createElement(SafeStopCard, { scenario, result: stopped("BANK_LOOKUP_UNAVAILABLE"), onDone: vi.fn(), onStartOver: vi.fn(), onCheckStatus: vi.fn() }));
    expect(html).toContain("Confirming transaction status"); expect(html).toContain("Please don’t try again yet");
    expect(html).not.toMatch(/Payment failed|Nothing was executed/iu);
    expect(html).toContain("Check status"); expect(html).not.toContain("Start another request");
  });
  it("keeps a bank-accepted effect pending confirmation and never calls it not executed", () => {
    const html = renderToStaticMarkup(createElement(SafeStopCard, { scenario, result: pendingConfirmation("ACCEPTED", "BANK_ACCEPTED_CONFIRMATION_PENDING"), onDone: vi.fn(), onStartOver: vi.fn(), onCheckStatus: vi.fn() }));
    expect(html).toContain("The bank accepted this transaction"); expect(html).toContain("Confirming transaction status"); expect(html).toContain("Check status");
    expect(html).not.toContain("Not executed"); expect(html).not.toContain("Payment stopped safely"); expect(html).not.toContain("Start another request");
  });
  it("keeps a settled bank effect completed while final bookkeeping is confirmed", () => {
    const html = renderToStaticMarkup(createElement(SafeStopCard, { scenario, result: pendingConfirmation("SETTLED", "SETTLED_BOOKKEEPING_PENDING"), onDone: vi.fn(), onStartOver: vi.fn(), onCheckStatus: vi.fn() }));
    expect(html).toContain("complete at the bank"); expect(html).toContain("is-complete"); expect(html).toContain("Check status");
    expect(html).not.toContain("Not executed"); expect(html).not.toContain("Start another request");
  });
  it("never offers a new request when reconciliation conflicts with the approved effect", () => {
    const html = renderToStaticMarkup(createElement(SafeStopCard, { scenario, result: stopped("RECONCILIATION_CONFLICT"), onDone: vi.fn(), onStartOver: vi.fn(), onCheckStatus: vi.fn() }));
    expect(html).toContain("could not safely confirm the bank result"); expect(html).toContain("Done");
    expect(html).not.toContain("Payment stopped safely"); expect(html).not.toContain("Stopped safely"); expect(html).not.toContain("Start another request");
  });
  it("does not call an accepted bank effect safely stopped when its reason is unfamiliar", () => {
    const html = renderToStaticMarkup(createElement(SafeStopCard, { scenario, result: pendingConfirmation("ACCEPTED", "FUTURE_LOCAL_CONFIRMATION_REASON"), onDone: vi.fn(), onStartOver: vi.fn(), onCheckStatus: vi.fn() }));
    expect(html).not.toContain("Payment stopped safely"); expect(html).not.toContain("Not executed"); expect(html).not.toContain("Start another request");
  });
  it("keeps a settled bank effect visually complete without calling it safely stopped when its reason is unfamiliar", () => {
    const html = renderToStaticMarkup(createElement(SafeStopCard, { scenario, result: pendingConfirmation("SETTLED", "FUTURE_LOCAL_CONFIRMATION_REASON"), onDone: vi.fn(), onStartOver: vi.fn(), onCheckStatus: vi.fn() }));
    expect(html).toContain("is-complete"); expect(html).toContain("Payment completed");
    expect(html).not.toContain("Payment stopped safely"); expect(html).not.toContain("Start another request");
  });
  it("continues to call a known deterministic pre-write stop safely stopped", () => {
    const html = renderToStaticMarkup(createElement(SafeStopCard, { scenario, result: stopped("GOAL_CONSTRAINT_VIOLATION"), onDone: vi.fn(), onStartOver: vi.fn(), onCheckStatus: vi.fn() }));
    expect(html).toContain("Payment stopped safely");
  });
});

it("renders reapproval as a distinct route-change outcome", () => {
  const props = { scenario, onCancel: vi.fn(), onReview: vi.fn() };
  const html = renderToStaticMarkup(createElement(ReapprovalCard, props));
  expect(html).toContain("The route changed — approval is required again");
  expect(html).toContain("Your payment details have changed");
  expect(html).toContain("Review updated plan"); expect(html).toContain("Your previous authorisation was not reused");
  expect(html).not.toContain("No longer available");
});

it("describes unavailable recovery without claiming failure or inviting a repeat", () => {
  const html = renderToStaticMarkup(createElement(RecoveryStatusCard, { onCheckStatus: vi.fn() }));
  expect(html).toContain("couldn’t confirm the latest status yet"); expect(html).toContain("Please don’t repeat this request"); expect(html).toContain("Check status");
  expect(html).not.toMatch(/No money moved|Start another request|failed/iu);
});

it("shows each settled and unsettled action in a partial completion warning", () => {
  const partialScenario = { ...scenario, steps: [...scenario.steps, { id: "buy", kind: "Buy", title: "1 Apple share", summary: "Investment Account", meta: [] }] };
  const result = ExecutionResultV1.parse({
    schemaVersion: "1", executionId: "execution", planId: "plan", status: "FAILED", startedStateVersion: 7, finalStateVersion: 8,
    steps: [{ stepId: "send", status: "SETTLED", idempotencyKey: "send-key", bankReference: "send-ref" }, { stepId: "buy", status: "FAILED", idempotencyKey: "buy-key", errorCode: "QUOTE_EXPIRED" }],
    goalOutcome: { achieved: false, summary: "Second action stopped." },
  });
  const html = renderToStaticMarkup(createElement(PartialCompletionCard, { scenario: partialScenario, result, onDone: vi.fn() }));
  expect(html).toContain("Some actions completed"); expect(html).toContain("Completed"); expect(html).toContain("Not completed");
  expect(html).toContain("Do not repeat the whole request"); expect(html).not.toContain("Start another request");
});

it("keeps meaning confirmation distinct from passkey authorization", () => {
  const goalHtml = renderToStaticMarkup(createElement(UnderstoodGoalCard, { goal: scenario.goal, onEdit: vi.fn(), onConfirm: vi.fn() }));
  const planHtml = renderToStaticMarkup(createElement(FinancialPlanPreview, { scenario, onCancel: vi.fn(), onApprove: vi.fn() }));
  expect(goalHtml).toContain("Yes, that’s correct");
  expect(goalHtml).toContain("does not approve a payment");
  expect(goalHtml).not.toContain("Confirm with passkey");
  expect(planHtml).toContain("Review payment details");
  expect(planHtml).toContain("Confirm with passkey");
  expect(planHtml).toContain("DBS Multiplier Account");
  expect(planHtml).not.toMatch(/acc-|ben-|FX_CONVERT|TRANSFER/u);
});

it("renders one customer-safe combined meaning confirmation with explicit ordering only", () => {
  const html = renderToStaticMarkup(createElement(UnderstoodBundleCard, { bundle: { items: [{ itemId: "item-1", text: "Send USD 300.00 to John Tan", ordered: false }, { itemId: "item-2", text: "Buy 1 Apple share", ordered: true }], constraints: ["Keep at least SGD 1,000.00 available"] }, onEdit: vi.fn(), onConfirm: vi.fn() }));
  expect(html).toContain("Check what we understood"); expect(html).toContain("Send USD 300.00 to John Tan"); expect(html).toContain("Then </strong>Buy 1 Apple share");
  expect(html).toContain("Keep at least SGD 1,000.00 available"); expect(html).toContain("Yes, that’s correct"); expect(html).toContain("Make changes");
  expect(html).toContain("does not approve a transaction"); expect(html).not.toMatch(/item-1|item-2|contractHash|GoalBundle|compiler/iu);
});

it("renders completion as a customer payment receipt without execution enums", () => {
  const items = [
    { label: "Latest account state checked", status: "complete" as const },
    { label: "Approved route verified", status: "complete" as const },
    { label: "Send USD 70.00", status: "complete" as const },
    { label: "Confirmed with bank", status: "complete" as const },
  ];
  const html = renderToStaticMarkup(createElement(ExecutionTimeline, { scenario, steps: scenario.steps, items }));
  expect(html).toContain("Payment completed");
  expect(html).toContain("USD 70.00");
  expect(html).toContain("Nanyang Technological University");
  expect(html).not.toMatch(/SETTLED|ExecutionRun|state version/u);
});

it("uses investment language throughout stock plan review and completion", () => {
  const preview = renderToStaticMarkup(createElement(FinancialPlanPreview, { scenario: investmentScenario, onCancel: vi.fn(), onApprove: vi.fn() }));
  const timeline = renderToStaticMarkup(createElement(ExecutionTimeline, {
    scenario: investmentScenario, steps: investmentScenario.steps,
    items: [
      { label: "Latest account state checked", status: "complete" as const },
      { label: "Investment approval checked", status: "complete" as const },
      { label: "1 Apple", status: "complete" as const },
      { label: "Confirmed with bank", status: "complete" as const },
    ],
  }));
  const meaning = renderToStaticMarkup(createElement(UnderstoodGoalCard, { goal: investmentScenario.goal, onEdit: vi.fn(), onConfirm: vi.fn() }));
  expect(preview).toContain("Investment details");
  expect(preview).toContain("<small>Investment</small>");
  expect(timeline).toContain("Investment completed");
  expect(meaning).toContain("Confirming the request does not authorize a purchase");
  expect(`${preview}${timeline}${meaning}`).not.toMatch(/Payment details|Payment completed|approve a payment/iu);
});

it("keeps quote expiry visible and disables passkey approval until review data is ready", () => {
  const html = renderToStaticMarkup(createElement(FinancialPlanPreview, { scenario: { ...investmentScenario, validUntil: "2026-10-11T10:00:00.000Z" }, onCancel: vi.fn(), onApprove: vi.fn(), reviewReady: false }));
  expect(html).toContain("Quotes valid until");
  expect(html).toContain("review a new plan");
  expect(html).toContain("Checking quote…");
  expect(html).toMatch(/button[^>]*disabled=""[^>]*>Checking quote/u);
});

it("renders the completed investment receipt from authoritative current state", () => {
  const currentState = BankStateSnapshotV1.parse({
    schemaVersion: "1", userId: "user", stateVersion: 11, capturedAt: "2026-10-11T09:00:00.000Z",
    accounts: [{ id: "acc-sgd", type: "CHECKING", currency: "SGD", ledgerMinorUnits: "1705201", availableMinorUnits: "1705201", status: "ACTIVE", capabilities: ["CONVERT_FX"] }, { id: "acc-usd", type: "BROKERAGE", currency: "USD", ledgerMinorUnits: "0", availableMinorUnits: "0", status: "ACTIVE", capabilities: ["TRADE_ASSET"] }],
    beneficiaries: [], assets: [{ id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY", tradable: true, settlementCurrency: "USD" }], holdings: [{ assetId: "asset-aapl", quantity: "1" }], obligations: [], serviceAvailability: { transfers: true, fx: true, billPayments: true, investments: true }, fxQuotes: [], assetQuotes: [],
  });
  const receiptScenario: PlanPresentation = { ...investmentScenario, projectedHoldings: [{ assetId: "asset-aapl", asset: "Apple", quantity: "1" }] };
  const html = renderToStaticMarkup(createElement(ExecutionTimeline, { scenario: receiptScenario, steps: receiptScenario.steps, currentState, reference: "execution-reference", items: [{ label: "State checked", status: "complete" as const }, { label: "Approval checked", status: "complete" as const }, { label: "Buy", status: "complete" as const }, { label: "Bank confirmed", status: "complete" as const }] }));
  expect(html).toContain("Investment successful");
  expect(html).toContain("1 share");
  expect(html).toContain("S$17,052.01");
  expect(html).toContain("US$0.00");
  expect(html).toContain("execution-reference");
});

describe("ClarificationCard", () => {
  const base = { reason: "UNRESOLVED_REFERENCE", field: "recipientReference", originalReference: "NTU", questionKey: "recipient" };

  it("does not claim competing beneficiaries when there are no options", () => {
    const props = { clarification: { ...base, options: [] }, options: [], reference: "NTU", onSelect: vi.fn(), onCancel: vi.fn() };
    const html = renderToStaticMarkup(createElement(ClarificationCard, props));
    expect(html).toContain("couldn&#x27;t confidently match that reference");
    expect(html).not.toContain("These beneficiaries");
  });

  it("communicates ambiguity when there are multiple options", () => {
    const options = [
      { entityId: "ben-john-tan", entityType: "BENEFICIARY" as const, displayName: "John Tan" },
      { entityId: "ben-john-lim", entityType: "BENEFICIARY" as const, displayName: "John Lim" },
    ];
    const props = { clarification: { ...base, originalReference: "John", options }, beneficiaries: [
      { id: "ben-john-tan", name: "John Tan", supportedCurrencies: ["SGD"], status: "ACTIVE" as const },
      { id: "ben-john-lim", name: "John Lim", supportedCurrencies: ["SGD"], status: "ACTIVE" as const },
    ], onSelect: vi.fn(), onCancel: vi.fn() };
    const html = renderToStaticMarkup(createElement(ClarificationCard, props));
    expect(html).toContain("Which John would you like to pay?");
    expect(html).toContain("more than one saved payee matching John");
    expect(html).toContain("John Tan");
    expect(html).toContain("John Lim");
    expect(html).toContain("Saved payee · SGD transfers");
  });

  it("uses an actionable saved-payee prompt when no beneficiary matches", () => {
    const html = renderToStaticMarkup(createElement(ClarificationCard, {
      clarification: { ...base, originalReference: "Unknown John", options: [] },
      onSelect: vi.fn(), onAnswerText: vi.fn(), onCancel: vi.fn(),
    }));
    expect(html).toContain("Enter a saved payee name");
    expect(html).toContain("For example, John Tan");
    expect(html).not.toContain("DBS Multiplier Account");
  });

  it("shows real account balances and keeps typed clarification available", () => {
    const options = [
      { entityId: "acc-1", entityType: "ACCOUNT" as const, displayName: "DBS Multiplier Account", currency: "SGD", availableMinorUnits: "1733334" },
      { entityId: "acc-2", entityType: "ACCOUNT" as const, displayName: "Savings Account", currency: "SGD", availableMinorUnits: "842000" },
    ];
    const props = { clarification: { ...base, field: "preferences[0].accountReference", originalReference: "my SGD account", options }, onSelect: vi.fn(), onAnswerText: vi.fn(), onCancel: vi.fn() };
    const html = renderToStaticMarkup(createElement(ClarificationCard, props));
    expect(html).toContain("Which SGD account would you like me to use for the shortfall?");
    expect(html).toContain("DBS Multiplier Account"); expect(html).toContain("SGD 17,333.34"); expect(html).toContain("Savings Account"); expect(html).toContain("SGD 8,420.00");
    expect(html).toContain("Or type the name you use for it"); expect(html).toContain("Start over");
  });

  it("uses investment-specific wording for an unresolved asset", () => {
    const props = {
      clarification: { ...base, field: "goal.assetReference", originalReference: "Unknown Corp", options: [] },
      onSelect: vi.fn(), onAnswerText: vi.fn(), onCancel: vi.fn(),
    };
    const html = renderToStaticMarkup(createElement(ClarificationCard, props));
    expect(html).toContain("Enter a company name or ticker");
    expect(html).toContain("Enter a company name or ticker, e.g. AAPL");
    expect(html).not.toContain("DBS Multiplier Account");
  });

  it("labels ambiguous asset candidates as supported investments", () => {
    const props = {
      clarification: { ...base, field: "goal.assetReference", originalReference: "Apple", options: [
        { entityId: "asset-aapl", entityType: "ASSET" as const, displayName: "Apple Inc." },
        { entityId: "asset-aple", entityType: "ASSET" as const, displayName: "Apple Hospitality REIT" },
      ] },
      onSelect: vi.fn(), onAnswerText: vi.fn(), onCancel: vi.fn(),
    };
    const html = renderToStaticMarkup(createElement(ClarificationCard, props));
    expect(html).toContain("Which Apple did you mean?");
    expect(html.match(/Supported investment/gu)).toHaveLength(2);
    expect(html).not.toContain("Available account");
  });
});
