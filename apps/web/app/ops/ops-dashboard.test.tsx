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
    const html = renderToStaticMarkup(createElement(OpsDashboard, { runs: [run("COMPLETED")] }));
    expect(html).toContain("AI understands the request.");
    expect(html).toContain("Deterministic bank logic decides how money moves.");
    expect(html).toContain("confirmed with bank");
    expect(html).toContain("Plan compiled");
    expect(html).toContain("USD 7,000.00");
  });

  it("renders candidate-only stages without inventing plan or execution detail", () => {
    const value = run("AWAITING_MEANING_CONFIRMATION", {
      confirmedGoal: stage("WAITING", "Waiting for meaning confirmation"),
      plan: stage("NOT_REACHED", "Meaning not yet confirmed"),
      authorization: stage("NOT_REACHED", "No plan to authorize"),
      execution: stage("NOT_REACHED", "Authorization not complete"),
      bankResult: stage("NOT_REACHED", "Execution never reached the bank"),
    });
    const html = renderToStaticMarkup(createElement(OpsDashboard, { runs: [value] }));
    expect(html).toContain("Waiting for meaning confirmation");
    expect(html).toContain("Execution never reached the bank");
    expect(html).not.toContain("Execution completed");
  });

  it.each(["PAUSED", "REAPPROVAL_REQUIRED"])("renders %s as stopped", (stateName) => {
    const value = run(stateName, { execution: stage("STOPPED", stateName === "REAPPROVAL_REQUIRED" ? "Route changed — prior authorization cannot continue" : "Execution paused"), bankResult: stage("STOPPED", "No settled bank operation recorded") });
    const html = renderToStaticMarkup(createElement(OpsDashboard, { runs: [value] }));
    expect(html).toContain(stateName === "REAPPROVAL_REQUIRED" ? "Reapproval required" : "Paused");
    expect(html).toContain("stopped");
  });

  it("shows missing ApprovalEvidence and exposes no mutation controls", () => {
    const value = run("AUTHORIZATION_FAILED", { authorization: stage("FAILED", "Approval exists without verification evidence", { approvalEvidence: "missing", userVerified: false }), execution: stage("NOT_REACHED", "Authorization not complete"), bankResult: stage("NOT_REACHED", "Execution never reached the bank") });
    const html = renderToStaticMarkup(createElement(OpsDashboard, { runs: [value] }));
    expect(html).toContain("Approval exists without verification evidence");
    expect(html).toContain("missing");
    expect(html).not.toMatch(/<(button|form|input|textarea|select)\b/i);
    expect(html).not.toMatch(/approve|execute now|run execution/i);
  });
});
