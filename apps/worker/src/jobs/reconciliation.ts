export type ReconciliationStatus = "PENDING" | "SETTLED" | "FAILED" | "UNKNOWN";
export async function reconcileBankExecution(input: { accepted: boolean; bankStatus?: string }): Promise<ReconciliationStatus> {
  // TODO: refresh mock-bank state and match durable execution/audit records.
  if (!input.accepted) return "FAILED";
  if (input.bankStatus === "settled") return "SETTLED";
  if (input.bankStatus === "pending") return "PENDING";
  return "UNKNOWN";
}
