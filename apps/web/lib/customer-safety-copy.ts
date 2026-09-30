export type CustomerExecutionState = "PAUSED" | "POLICY_BLOCKED" | "REAPPROVAL_REQUIRED";

const executionReasonMessages: Readonly<Record<string, string>> = {
  GOAL_CONSTRAINT_VIOLATION: "Could not verify this step safely",
  QUOTE_EXPIRED: "The exchange quote is no longer valid",
  FX_QUOTE_INVALID: "The exchange quote is no longer valid",
  FX_UNAVAILABLE: "Currency conversion is currently unavailable",
  TRANSFER_RAIL_UNAVAILABLE: "This transfer route is currently unavailable",
};

export function customerExecutionMessage(reasonCode?: string, state: CustomerExecutionState = "POLICY_BLOCKED"): string {
  if (state === "REAPPROVAL_REQUIRED") return "The route changed — approval is required again";
  return (reasonCode && executionReasonMessages[reasonCode]) ?? "This step cannot currently be completed safely";
}

export function clarificationCopy(optionCount: number): string {
  if (optionCount > 1) return "I found more than one possible match. Please choose the one you meant. Different choices could lead to different financial outcomes.";
  if (optionCount === 1) return "I found one possible match. Please confirm whether this is the one you meant.";
  return "I couldn't confidently match that reference. Please clarify it.";
}
