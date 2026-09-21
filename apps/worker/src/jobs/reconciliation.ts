export type ReconciliationStatus = "PENDING" | "SETTLED" | "FAILED" | "UNKNOWN";
export async function reconcileBankExecution(input: { accepted: boolean; bankStatus?: string }): Promise<ReconciliationStatus> {
  // The caller supplies status read from the bank adapter; this classifier never fabricates settlement.
  if (!input.accepted) return "FAILED";
  if (input.bankStatus === "settled") return "SETTLED";
  if (input.bankStatus === "pending") return "PENDING";
  return "UNKNOWN";
}
