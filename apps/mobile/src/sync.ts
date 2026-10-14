import type { BankState } from "./api";

export function verifiedCustomerSnapshot(customerId: string, incoming: BankState, previous?: BankState): BankState {
  if (incoming.userId !== customerId) throw new Error("CUSTOMER_STATE_MISMATCH");
  if (previous?.userId === customerId && incoming.stateVersion < previous.stateVersion) throw new Error("STATE_VERSION_REGRESSED");
  return incoming;
}
