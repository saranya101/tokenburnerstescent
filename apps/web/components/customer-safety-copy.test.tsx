import { ExecutionResultV1 } from "@parlance/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanPresentation } from "../lib/customer-presentation";
import { ReapprovalCard } from "./execution/reapproval-card";
import { SafeStopCard } from "./execution/safe-stop-card";
import { ClarificationCard } from "./goal/clarification-card";

const scenario: PlanPresentation = {
  goal: { eyebrow: "Send money", title: "Send USD 70.00", description: "Send money", details: [], constraints: [], preferences: [] },
  planTitle: "One transfer", planSummary: "Latest account state checked", preservedConstraints: [],
  steps: [{ id: "send", kind: "Transfer", title: "Send USD 70.00", summary: "Account → beneficiary", meta: [] }],
};

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
    expect(html).toContain("Execution stopped safely");
    expect(html).toContain("No unapproved action will continue");
  });
});

it("renders reapproval as a distinct route-change outcome", () => {
  const props = { scenario, onCancel: vi.fn(), onStartOver: vi.fn(), onReview: vi.fn() };
  const html = renderToStaticMarkup(createElement(ReapprovalCard, props));
  expect(html).toContain("The route changed — approval is required again");
  expect(html).not.toContain("No longer available");
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
