import { describe, expect, it } from "vitest";
import type { BankState } from "./api";
import { verifiedCustomerSnapshot } from "./sync";

const state = (userId: string, stateVersion: number) => ({ userId, stateVersion }) as BankState;

describe("customer snapshot acceptance", () => {
  it("accepts a newer version for the authenticated customer", () => {
    expect(verifiedCustomerSnapshot("alice", state("alice", 8), state("alice", 7)).stateVersion).toBe(8);
  });
  it("rejects a cross-customer response and a state rollback", () => {
    expect(() => verifiedCustomerSnapshot("alice", state("bob", 8))).toThrow("CUSTOMER_STATE_MISMATCH");
    expect(() => verifiedCustomerSnapshot("alice", state("alice", 6), state("alice", 7))).toThrow("STATE_VERSION_REGRESSED");
  });
});
