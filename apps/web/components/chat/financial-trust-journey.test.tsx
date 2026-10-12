import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinancialTrustJourney, trustJourneyForState } from "./financial-trust-journey";

describe("financial trust journey", () => {
  it("shows an incomplete request as interpretation in progress without advancing later gates", () => {
    const stages = trustJourneyForState({ phase: "CLARIFICATION" });

    expect(stages.map((stage) => stage.status)).toEqual(["active", "waiting", "waiting", "waiting", "waiting", "waiting"]);
  });

  it("shows a successful deterministic plan without implying authorization or execution", () => {
    const stages = trustJourneyForState({ phase: "PLAN_REVIEW" });

    expect(stages.map((stage) => stage.status)).toEqual(["complete", "complete", "complete", "waiting", "waiting", "waiting"]);
  });

  it.each([
    ["AUTHORIZING", ["complete", "complete", "complete", "active", "waiting", "waiting"]],
    ["AUTHORIZED", ["complete", "complete", "complete", "complete", "waiting", "waiting"]],
    ["EXECUTING", ["complete", "complete", "complete", "complete", "active", "waiting"]],
  ] as const)("does not advance beyond the authoritative %s phase", (phase, expected) => {
    expect(trustJourneyForState({ phase }).map((stage) => stage.status)).toEqual(expected);
  });

  it("distinguishes a protected-balance planning refusal from understood and confirmed meaning", () => {
    const stages = trustJourneyForState({ phase: "UNAVAILABLE", reasonCode: "MIN_AVAILABLE_BALANCE_VIOLATED" });

    expect(stages.map((stage) => stage.status)).toEqual(["complete", "complete", "stopped", "waiting", "waiting", "waiting"]);
    expect(stages[2]?.detail).toBe("Protected balance preserved");
  });

  it("marks every stage complete only for an authoritatively completed execution", () => {
    const stages = trustJourneyForState({ phase: "COMPLETED" });

    expect(stages.every((stage) => stage.status === "complete")).toBe(true);
    expect(stages.at(-1)?.detail).toBe("Final state verified");
  });

  it("renders accessible live status without exposing internal identifiers", () => {
    const html = renderToStaticMarkup(createElement(FinancialTrustJourney, { state: { phase: "AUTHORIZING" } }));

    expect(html).toContain("Parlance trust journey");
    expect(html).toContain("Passkey authorization");
    expect(html).toContain('aria-current="step"');
    expect(html).not.toContain("planHash");
    expect(html).not.toContain("executionId");
  });
});
