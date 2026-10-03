import { ExecutionResultV1 } from "@parlance/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlanPresentation } from "../lib/customer-presentation";
import { customerDesktopNavigation, customerMobileNavigation } from "./banking/banking-nav";
import { ConversationComposer } from "./chat/conversation-composer";
import { ReapprovalCard } from "./execution/reapproval-card";
import { SafeStopCard } from "./execution/safe-stop-card";
import { ExecutionTimeline } from "./execution/execution-timeline";
import { ClarificationCard } from "./goal/clarification-card";
import { UnderstoodGoalCard } from "./goal/understood-goal-card";
import { UnderstoodBundleCard } from "./goal/understood-bundle-card";
import { FinancialPlanPreview } from "./plan/financial-plan-preview";

const scenario: PlanPresentation = {
  goal: { eyebrow: "Send money", title: "Send USD 70.00 to Nanyang Technological University", description: "Send money", details: [{ label: "Amount", value: "USD 70.00" }, { label: "To", value: "Nanyang Technological University" }], constraints: [], preferences: [] },
  planTitle: "Review payment details", planSummary: "Latest account information checked", funding: [{ account: "DBS Multiplier Account", amount: "SGD 26.66", detail: "Converted to USD" }], preservedConstraints: [],
  steps: [{ id: "send", kind: "Payment", title: "Send USD 70.00", summary: "USD Account to Nanyang Technological University", meta: [] }],
};

it("presents the conversational route as Pay & Transfer in desktop and mobile banking navigation", () => {
  expect(customerDesktopNavigation.find((item) => item.href === "/chat")?.label).toBe("Pay & Transfer");
  expect(customerMobileNavigation.find((item) => item.href === "/chat")?.label).toBe("Pay & Transfer");
  expect(customerDesktopNavigation.map((item) => item.label)).not.toContain("Parlance");
});

it("renders a banking task entry instead of an AI prompt gallery", () => {
  const html = renderToStaticMarkup(createElement(ConversationComposer, { onSubmit: vi.fn() }));
  expect(html).toContain("Tell us what you’d like to do");
  expect(html).toContain("Send money");
  expect(html).toContain("Pay a bill");
  expect(html).not.toMatch(/Ask Parlance|AI helps|prompt/iu);
  expect(html).toContain("Use microphone for voice input");
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("Voice input");
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

describe("SafeStopCard", () => {
  it.each([
    ["GOAL_CONSTRAINT_VIOLATION", "Could not verify this step safely"],
    ["QUOTE_EXPIRED", "The exchange quote is no longer valid"],
    ["FX_UNAVAILABLE", "Currency conversion is currently unavailable"],
  ])("renders precise copy for %s", (reason, message) => {
    const props = { scenario, result: stopped(reason), onDone: vi.fn(), onStartOver: vi.fn(), onShowRouteChange: vi.fn() };
    const html = renderToStaticMarkup(createElement(SafeStopCard, props));
    expect(html).toContain(message);
    expect(html).not.toContain("No longer available");
    expect(html).toContain("Payment stopped safely");
    expect(html).toContain("No unapproved action will continue");
  });
  it("does not claim failure or invite retry while the bank outcome is unknown", () => {
    const html = renderToStaticMarkup(createElement(SafeStopCard, { scenario, result: stopped("BANK_LOOKUP_UNAVAILABLE"), onDone: vi.fn(), onStartOver: vi.fn() }));
    expect(html).toContain("Confirming transaction status"); expect(html).toContain("Please don’t try again yet");
    expect(html).not.toMatch(/Payment failed|Nothing was executed/iu);
  });
});

it("renders reapproval as a distinct route-change outcome", () => {
  const props = { scenario, onCancel: vi.fn(), onStartOver: vi.fn(), onReview: vi.fn() };
  const html = renderToStaticMarkup(createElement(ReapprovalCard, props));
  expect(html).toContain("The route changed — approval is required again");
  expect(html).toContain("Your payment details have changed");
  expect(html).not.toContain("No longer available");
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
      { entityId: "ben-1", entityType: "BENEFICIARY" as const, displayName: "NTU Bursary" },
      { entityId: "ben-2", entityType: "BENEFICIARY" as const, displayName: "NTU Tuition" },
    ];
    const legacyOptions = options.map((option, index) => ({ id: option.entityId, name: option.displayName, bank: "DBS beneficiary", account: `•••• 000${index}` }));
    const props = { clarification: { ...base, options }, options: legacyOptions, reference: "NTU", onSelect: vi.fn(), onCancel: vi.fn() };
    const html = renderToStaticMarkup(createElement(ClarificationCard, props));
    expect(html).toContain("more than one possible match");
    expect(html).toContain("different financial outcomes");
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
});
