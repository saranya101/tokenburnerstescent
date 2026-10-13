import type { GoalContractV1 } from "@parlance/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { useBankingState } from "../../hooks/use-banking-state";
import { useCustomerFlow } from "../../hooks/use-customer-flow";
import type { CustomerFlowState } from "../../lib/customer-flow";
import { authoritativeOutcomeRefreshKey, ChatExperience } from "./chat-experience";

vi.mock("../../hooks/use-customer-flow", () => ({ useCustomerFlow: vi.fn() }));
vi.mock("../../hooks/use-banking-state", () => ({ useBankingState: vi.fn() }));

const reset = vi.fn();
const amendRequest = vi.fn();

function render(state: CustomerFlowState): string {
  vi.mocked(useCustomerFlow).mockReturnValue({ state, reset, amendRequest } as unknown as ReturnType<typeof useCustomerFlow>);
  return renderToStaticMarkup(createElement(ChatExperience));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useBankingState).mockReturnValue({
    state: {
      capturedAt: "2026-10-10T06:00:00.000Z",
      accounts: [
        { id: "acc-usd", type: "CHECKING", currency: "USD", ledgerMinorUnits: "1234", availableMinorUnits: "1234", status: "ACTIVE", capabilities: ["TRADE_ASSET"] },
        { id: "acc-sgd", type: "CHECKING", currency: "SGD", ledgerMinorUnits: "250000", availableMinorUnits: "250000", status: "ACTIVE", capabilities: ["CONVERT_FX"] },
      ],
      holdings: [], assetQuotes: [], fxQuotes: [], beneficiaries: [], obligations: [], services: [], stateVersion: 1,
    },
    activity: { schemaVersion: "1", capturedAt: "2026-10-10T06:00:00.000Z", items: [] },
    loading: false, error: undefined, refresh: vi.fn(),
  } as unknown as ReturnType<typeof useBankingState>);
});

it("refreshes authoritative banking data for completed and partial terminal outcomes only", () => {
  const result = { executionId: "execution-1", finalStateVersion: 8 };
  expect(authoritativeOutcomeRefreshKey({ phase: "PARTIALLY_COMPLETED", result } as unknown as CustomerFlowState)).toBe("PARTIALLY_COMPLETED:execution-1:8");
  expect(authoritativeOutcomeRefreshKey({ phase: "PAUSED", result } as unknown as CustomerFlowState)).toBe("PAUSED:execution-1:8");
  expect(authoritativeOutcomeRefreshKey({ phase: "COMPLETED", result } as unknown as CustomerFlowState)).toBe("COMPLETED:execution-1:8");
  expect(authoritativeOutcomeRefreshKey({ phase: "EXECUTING", result } as unknown as CustomerFlowState)).toBeUndefined();
});

it("presents asset clarification as an investment request", () => {
  const html = render({
    phase: "CLARIFICATION", requestText: "Buy 1 share of Unknown Corp.", clarificationId: "clarification-asset", answers: [], bundle: false,
    clarifications: [{ reason: "ENTITY_NOT_FOUND", field: "goal.assetReference", originalReference: "Unknown Corp", questionKey: "clarify.entity.not_found", options: [] }],
  });

  expect(html).toContain("Your investment request");
  expect(html).toContain("Enter a company name or ticker, e.g. AAPL");
  expect(html).not.toContain("Your payment request");
});

it.each([
  ["clarify.transfer.recipient", "goal.recipientReference", "Who would you like to send money to?", "For example, John Tan"],
  ["clarify.transfer.amount", "goal.amount", "How much would you like to send, and in which currency?", "For example, S$500 or USD 500"],
  ["clarify.transfer.currency", "goal.amount.currency", "Which currency should I use for this transfer?", "Enter SGD or USD"],
] as const)("renders actionable %s clarification copy", (questionKey, field, question, placeholder) => {
  const html = render({
    phase: "CLARIFICATION", requestText: "Send money to John", clarificationId: "clarification-transfer", answers: [], bundle: false,
    clarifications: [{ reason: "MISSING_FIELD", field, originalReference: field, questionKey, options: [] }],
  });
  expect(html).toContain(question);
  expect(html).toContain(placeholder);
  expect(html).toContain("Start over");
  expect(html).not.toContain("Please clarify your request");
});

it("renders clarification submission progress and an actionable grounding error", () => {
  const base = {
    phase: "CLARIFICATION" as const,
    requestText: "Buy 1 share of Apple (AAPL), using SGD if necessary.",
    clarificationId: "clarification-account", answers: [], bundle: false,
    clarifications: [{ reason: "ENTITY_NOT_FOUND", field: "preferences[0].accountReference", originalReference: "SGD if necessary", questionKey: "clarify.entity.not_found", options: [] }],
  };
  expect(render({ ...base, submitting: true })).toContain("Checking…");
  const rejected = render({ ...base, error: "We couldn’t match that answer to an eligible banking record." });
  expect(rejected).toContain("We couldn’t match that answer to an eligible banking record.");
  expect(rejected).toContain('role="alert"');
});

it("shows live USD availability when an investment has insufficient settled funds", () => {
  const goal = {
    goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" },
  } as GoalContractV1;
  const html = render({
    phase: "UNAVAILABLE", requestText: "Buy 1 share of Apple (AAPL).", kind: "UNSAT", reasonCode: "INSUFFICIENT_FUNDS",
    message: "The available settlement funds do not cover the quoted total.", goal,
  });

  expect(html).toContain("Your investment needs USD funding");
  expect(html).toContain("available USD balance is US$12.34");
  expect(html).toContain("Would you like to review converting SGD to USD to fund this purchase?");
  expect(html).toContain("S$2,500.00 available");
  expect(html).toContain("Review funding options");
  expect(html).toContain("Not now");
  expect(html).not.toContain("complete this payment");
});

it("presents a verified protected-balance refusal from compiler and live banking data", () => {
  vi.mocked(useBankingState).mockReturnValue({
    state: {
      schemaVersion: "1", userId: "user-1", capturedAt: "2026-10-10T06:00:00.000Z", stateVersion: 18,
      accounts: [
        { id: "acc-usd", type: "CHECKING", currency: "USD", ledgerMinorUnits: "0", availableMinorUnits: "0", status: "ACTIVE", capabilities: ["TRADE_ASSET"] },
        { id: "acc-sgd", type: "CHECKING", currency: "SGD", ledgerMinorUnits: "1705201", availableMinorUnits: "1705201", status: "ACTIVE", capabilities: ["CONVERT_FX"] },
      ],
      holdings: [], assets: [], assetQuotes: [], fxQuotes: [], beneficiaries: [], obligations: [], serviceAvailability: { transfers: true, fx: true, billPayments: true, investments: true },
    },
    activity: { schemaVersion: "1", capturedAt: "2026-10-10T06:00:00.000Z", items: [] }, loading: false, error: undefined, refresh: vi.fn(),
  } as unknown as ReturnType<typeof useBankingState>);
  const goal = {
    goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" },
    constraints: [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "1700000" }, accountId: "acc-sgd" }],
    preferences: [{ type: "PREFER_ACCOUNT", accountId: "acc-sgd" }],
    entityBindings: [],
  } as unknown as GoalContractV1;
  const html = render({
    phase: "UNAVAILABLE", requestText: "Buy 1 share of Apple (AAPL), using SGD if necessary, but keep at least S$17,000 available in my SGD account.",
    kind: "UNSAT", reasonCode: "MIN_AVAILABLE_BALANCE_VIOLATED", message: "Min available balance violated", goal,
    details: { bankStateVersion: 18, accountId: "acc-sgd", currency: "SGD", requiredMinorUnits: "1700000", projectedMinorUnits: "1689401" },
  });

  expect(html).toContain("Your protected balance comes first.");
  expect(html).toContain("Keep at least SGD 17,000.00 in DBS Multiplier Account");
  expect(html).toContain("S$17,052.01");
  expect(html).toContain("S$16,894.01");
  expect(html).toContain("S$105.99 below your minimum");
  expect(html).toContain("No transaction occurred.");
  expect(html).toContain("Amend request");
  expect(html).toContain("Start over");
  expect(html).not.toContain("Min available balance violated");
});

it("keeps generic refusal handling when compiler metadata does not match the confirmed constraint", () => {
  const goal = {
    goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" },
    constraints: [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "1700000" }, accountId: "acc-sgd" }],
    preferences: [], entityBindings: [],
  } as unknown as GoalContractV1;
  const html = render({
    phase: "UNAVAILABLE", requestText: "Buy Apple", kind: "UNSAT", reasonCode: "MIN_AVAILABLE_BALANCE_VIOLATED",
    message: "Min available balance violated", goal,
    details: { accountId: "another-account", currency: "SGD", requiredMinorUnits: "1700000", projectedMinorUnits: "1689401" },
  });
  expect(html).toContain("We can’t complete this investment right now");
  expect(html).toContain("Min available balance violated");
  expect(html).not.toContain("Your protected balance comes first.");
});

it("omits the current balance when live state is newer than the refusal simulation", () => {
  const goal = {
    goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" },
    constraints: [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "200000" }, accountId: "acc-sgd" }],
    preferences: [], entityBindings: [],
  } as unknown as GoalContractV1;
  const html = render({
    phase: "UNAVAILABLE", requestText: "Buy Apple", kind: "UNSAT", reasonCode: "MIN_AVAILABLE_BALANCE_VIOLATED",
    message: "Min available balance violated", goal,
    details: { bankStateVersion: 2, accountId: "acc-sgd", currency: "SGD", requiredMinorUnits: "200000", projectedMinorUnits: "190000" },
  });
  expect(html).toContain("Your protected balance comes first.");
  expect(html).toContain("S$1,900.00");
  expect(html).not.toContain("Live account balance");
  expect(html).not.toContain("<dt>Available now</dt>");
});
