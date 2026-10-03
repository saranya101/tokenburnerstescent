import { describe, expect, it } from "vitest";
import { clarificationCopy, customerExecutionMessage } from "./customer-safety-copy";

describe("customer-safe execution copy", () => {
  it.each([
    ["GOAL_CONSTRAINT_VIOLATION", "Could not verify this step safely"],
    ["QUOTE_EXPIRED", "The exchange quote is no longer valid"],
    ["FX_QUOTE_INVALID", "The exchange quote is no longer valid"],
    ["FX_UNAVAILABLE", "Currency conversion is currently unavailable"],
    ["TRANSFER_RAIL_UNAVAILABLE", "This transfer route is currently unavailable"],
  ])("maps %s to a precise customer message", (reason, message) => {
    expect(customerExecutionMessage(reason)).toBe(message);
    expect(customerExecutionMessage(reason)).not.toBe("No longer available");
  });

  it("keeps generic policy blocks and route changes distinct", () => {
    expect(customerExecutionMessage(undefined, "POLICY_BLOCKED")).toBe("This step cannot currently be completed safely");
    expect(customerExecutionMessage(undefined, "REAPPROVAL_REQUIRED")).toBe("The route changed — approval is required again");
  });
});

describe("clarification copy", () => {
  it("does not claim multiple beneficiaries when no options exist", () => {
    expect(clarificationCopy(0)).toBe("I couldn't confidently match that reference. Please clarify it.");
    expect(clarificationCopy(0)).not.toMatch(/beneficiaries|more than one/i);
  });

  it("communicates ambiguity only when multiple options exist", () => {
    expect(clarificationCopy(2)).toMatch(/more than one possible match/i);
    expect(clarificationCopy(2)).toMatch(/different financial outcomes/i);
  });
});
