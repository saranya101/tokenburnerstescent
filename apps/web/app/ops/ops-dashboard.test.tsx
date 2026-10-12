import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { OpsRun, OpsStage, OpsStageState } from "../../lib/ops-read-model";
import { OpsDashboard } from "./ops-dashboard";

function stage(state: OpsStageState, summary: string, detail?: Record<string, unknown>): OpsStage {
  return { state, summary, ...(detail ? { detail } : {}) };
}

function run(overallState: string, overrides: Partial<OpsRun["stages"]> = {}): OpsRun {
  return {
    id: "candidate…uvwxyz",
    occurredAt: "2026-09-29T10:00:00.000Z",
    headline: "Send USD 7,000.00 to NTU",
    overallState,
    stages: {
      request: stage("COMPLETE", "Customer request recorded", { customerText: "Send USD 7,000.00 to NTU" }),
      interpretation: stage("COMPLETE", "Deliver money", { goalType: "DELIVER_MONEY" }),
      semanticValidation: stage("COMPLETE", "Candidate matched request", { decision: "PASS" }),
      confirmedGoal: stage("COMPLETE", "Goal confirmed", { amount: { currency: "USD", minorUnits: "700000" }, contractHash: "aaaaaaaaaaaa…aaaaaaaa" }),
      plan: stage("COMPLETE", "SAT", { compilerOutcome: "SAT", actions: [{ sequence: 0, action: "TRANSFER" }] }),
      authorization: stage("COMPLETE", "Verified passkey evidence recorded", { method: "PASSKEY", userVerified: true }),
      execution: stage("COMPLETE", "Execution completed", { state: "COMPLETED" }),
      bankResult: stage("COMPLETE", "1 bank operation settled", { reconciliation: "confirmed with bank" }),
      ...overrides,
    },
    audit: [{ id: "audit-1", eventType: "PLAN_COMPILED", occurredAt: "2026-09-29T10:01:00.000Z", aggregateType: "FinancialPlan", aggregateId: "plan…uvwxyz", traceId: "trace…uvwxyz", metadata: { planId: "plan…uvwxyz" } }],
  };
}

describe("OpsDashboard", () => {
  it("renders the completed pipeline and the safety boundary", () => {
    const overview = renderToStaticMarkup(createElement(OpsDashboard, { runs: [run("COMPLETED")] }));
    expect(overview).toContain("AI understands the request.");
    expect(overview).toContain("Deterministic bank logic decides how money moves.");
    const detail = renderToStaticMarkup(createElement(OpsDashboard, { runs: [run("COMPLETED")], initialView: "executions", initialStage: "bankResult" }));
    expect(detail).toContain("confirmed with bank");
    expect(detail).toContain("Plan compiled");
    expect(detail).toContain("USD 7,000.00");
  });

  it("renders candidate-only stages without inventing plan or execution detail", () => {
    const value = run("AWAITING_MEANING_CONFIRMATION", {
      confirmedGoal: stage("WAITING", "Waiting for meaning confirmation"),
      plan: stage("NOT_REACHED", "Meaning not yet confirmed"),
      authorization: stage("NOT_REACHED", "No plan to authorize"),
      execution: stage("NOT_REACHED", "Authorization not complete"),
      bankResult: stage("NOT_REACHED", "Execution never reached the bank"),
    });
    const html = renderToStaticMarkup(createElement(OpsDashboard, { runs: [value], initialView: "executions" }));
    expect(html).toContain("Goal confirmation");
    expect(html).toContain("Waiting");
    expect(html).toContain("Execution never reached the bank");
    expect(html).not.toContain("Execution completed");
  });

  it("renders a confirmed transfer and investment bundle without treating its reserve as an amount", () => {
    const value = run("AWAITING_AUTHORIZATION", {
      interpretation: stage("COMPLETE", "2 financial intents interpreted", { interpretationType: "BUNDLE", groundedEntities: [
        { reference: "John Lim", entityType: "BENEFICIARY", canonicalId: "ben-john-lim", resolutionMethod: "EXACT" },
        { reference: "Apple (AAPL)", entityType: "ASSET", canonicalId: "asset-aapl", resolutionMethod: "ALIAS" },
        { reference: "my SGD account", entityType: "ACCOUNT", canonicalId: "acc-sgd", resolutionMethod: "ALIAS" },
      ] }),
      confirmedGoal: stage("COMPLETE", "2 confirmed goals in one bundle", {
        ownerType: "BUNDLE",
        goalTypes: ["DELIVER_MONEY", "ACQUIRE_ASSET"],
        items: [
          { sequence: 1, goalType: "DELIVER_MONEY", goal: { type: "DELIVER_MONEY", amount: { currency: "SGD", minorUnits: "10000" }, recipientId: "ben-john-lim" }, confirmedBindings: [{ reference: "John Lim", entityType: "BENEFICIARY", canonicalId: "ben-john-lim", confirmed: true }] },
          { sequence: 2, goalType: "ACQUIRE_ASSET", goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" }, preferences: [{ type: "PREFER_ACCOUNT", accountId: "acc-sgd" }], confirmedBindings: [{ reference: "Apple (AAPL)", entityType: "ASSET", canonicalId: "asset-aapl", confirmed: true }, { reference: "my SGD account", entityType: "ACCOUNT", canonicalId: "acc-sgd", confirmed: true }] },
        ],
        confirmedBindings: [{ reference: "John Lim", entityType: "BENEFICIARY", canonicalId: "ben-john-lim", confirmed: true }, { reference: "Apple (AAPL)", entityType: "ASSET", canonicalId: "asset-aapl", confirmed: true }],
        globalConstraints: [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "100000" }, accountId: "acc-sgd" }],
      }),
      plan: stage("COMPLETE", "SAT · 3 deterministic actions", { bankStateVersion: 7, actions: [
        { sequence: 0, action: "TRANSFER", parameters: { amount: { currency: "SGD", minorUnits: "10000" }, beneficiaryId: "ben-john-lim" } },
        { sequence: 1, action: "FX_CONVERT", parameters: { sourceMoney: { currency: "SGD", minorUnits: "26800" }, targetCurrency: "USD" } },
        { sequence: 2, action: "BUY_ASSET", parameters: { assetId: "asset-aapl", quantity: "1", maximumSpend: { currency: "USD", minorUnits: "20100" } } },
      ] }),
      authorization: stage("WAITING", "Waiting for passkey authorization"),
      execution: stage("NOT_REACHED", "Authorization not complete"),
      bankResult: stage("NOT_REACHED", "Execution never reached the bank"),
    });
    const html = renderToStaticMarkup(createElement(OpsDashboard, { runs: [value], initialView: "executions" }));
    expect(html).toContain("Transfer + Buy Asset");
    expect(html).toContain("<dt>Transfer</dt><dd>SGD 100.00 to John Lim</dd>");
    expect(html).toContain("<dt>Investment</dt><dd>Buy 1 AAPL share</dd>");
    expect(html).toContain("<dt>Funding</dt><dd>Conditional funding: SGD 268.00 → USD</dd>");
    expect(html).toContain("<dt>Minimum protected balance</dt><dd>SGD 1,000.00</dd>");
    expect(html).not.toContain("<dt>Amount</dt><dd>SGD 1,000.00</dd>");
    expect(html).toMatch(/Entities grounded[\s\S]*Verified/u);
    expect(html).toContain("Execution never reached the bank");
  });

  it.each(["PAUSED", "REAPPROVAL_REQUIRED"])("renders %s as stopped", (stateName) => {
    const value = run(stateName, { execution: stage("STOPPED", stateName === "REAPPROVAL_REQUIRED" ? "Route changed — prior authorization cannot continue" : "Execution paused"), bankResult: stage("STOPPED", "No settled bank operation recorded") });
    const html = renderToStaticMarkup(createElement(OpsDashboard, { runs: [value], initialView: "executions" }));
    expect(html).toContain(stateName === "REAPPROVAL_REQUIRED" ? "Reapproval required" : "Paused");
    expect(html).toContain("Stopped");
  });

  it("shows missing ApprovalEvidence and exposes no mutation controls", () => {
    const value = run("AUTHORIZATION_FAILED", { authorization: stage("FAILED", "Approval exists without verification evidence", { approvalEvidence: "missing", userVerified: false }), execution: stage("NOT_REACHED", "Authorization not complete"), bankResult: stage("NOT_REACHED", "Execution never reached the bank") });
    const html = renderToStaticMarkup(createElement(OpsDashboard, { runs: [value], initialView: "executions", initialStage: "authorization" }));
    expect(html).toContain("Approval exists without verification evidence");
    expect(html).toContain("missing");
    expect(html).not.toMatch(/approve|execute now|run execution/i);
  });

  it("renders deterministic risk evidence for a stopped REVIEW without exposing mutation controls", () => {
    const value = run("RISK_REVIEW", {
      authorization: stage("STOPPED", "Risk decision: REVIEW", { risk: { decision: "REVIEW", reasonCodes: ["SINGLE_TRANSACTION_REVIEW_THRESHOLD"], policyVersion: "demo-risk-v1", kycStatus: "VERIFIED", rollingUsage: [{ currency: "USD", settledAmountMinorUnits: "50100", settledTransactionCount: 1 }], reservation: "none" } }),
      execution: stage("NOT_REACHED", "Authorization not complete"),
      bankResult: stage("NOT_REACHED", "Execution never reached the bank"),
    });
    const html = renderToStaticMarkup(createElement(OpsDashboard, { runs: [value], initialView: "executions", initialStage: "authorization" }));
    expect(html).toContain("Risk review");
    expect(html).toContain("SINGLE_TRANSACTION_REVIEW_THRESHOLD");
    expect(html).toContain("demo-risk-v1");
    expect(html).toContain("50100");
    expect(html).not.toMatch(/approve|execute now|run execution/i);
  });

  it("renders explicit access, error and empty states without fallback metrics", () => {
    const access = renderToStaticMarkup(createElement(OpsDashboard, { runs: [], accessState: "required" }));
    expect(access).toContain("Operator sign-in required");
    expect(access).not.toContain("Total requests");
    const unavailable = renderToStaticMarkup(createElement(OpsDashboard, { runs: [], error: "Read model unavailable (503)" }));
    expect(unavailable).toContain("Read model unavailable (503)");
    expect(unavailable).toContain("No fallback records are displayed");
    const empty = renderToStaticMarkup(createElement(OpsDashboard, { runs: [] }));
    expect(empty).toContain("No Parlance requests recorded");
  });
});
