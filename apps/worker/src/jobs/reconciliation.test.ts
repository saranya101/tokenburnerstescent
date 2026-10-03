import { expect, it } from "vitest";
import { processNextRecovery, reconcilePersistedExecution, type ClaimedRecoveryWork, type PersistedExecutionEvidence, type RecoveryWorkStore } from "./reconciliation.js";

const store = (evidence: PersistedExecutionEvidence | null) => ({ async loadExecution() { return evidence; } });
const bank = (statuses: Record<string, "PENDING" | "SETTLED" | "FAILED" | "UNKNOWN">) => ({ async verify(reference: string) { return statuses[reference] ?? "UNKNOWN" as const; } });

it("does not infer settlement without bank-verifiable evidence", async () => { expect(await reconcilePersistedExecution("run", store({ executionState: "EXECUTING", steps: [{ status: "ACCEPTED" }] }), bank({}))).toBe("UNKNOWN"); });
it("classifies persisted pending and failed states without financial retries", async () => { expect(await reconcilePersistedExecution("run", store({ executionState: "AUTHORIZED", steps: [] }), bank({}))).toBe("PENDING"); expect(await reconcilePersistedExecution("run", store({ executionState: "FAILED", steps: [] }), bank({}))).toBe("FAILED"); });
it("reports settled only when every persisted step is bank-verified", async () => { const evidence = { executionState: "COMPLETED", steps: [{ status: "SETTLED", bankReference: "a" }, { status: "SETTLED", bankReference: "b" }] }; expect(await reconcilePersistedExecution("run", store(evidence), bank({ a: "SETTLED", b: "SETTLED" }))).toBe("SETTLED"); expect(await reconcilePersistedExecution("run", store(evidence), bank({ a: "SETTLED", b: "PENDING" }))).toBe("PENDING"); });

class MemoryRecoveryStore implements RecoveryWorkStore {
  status: "PENDING" | "PROCESSING" | "PUBLISHED" = "PENDING"; token?: string; claimedAt?: Date; attempts = 0;
  async claimNext(now: Date, leaseMs: number): Promise<ClaimedRecoveryWork | null> {
    const expired = this.status === "PROCESSING" && this.claimedAt !== undefined && this.claimedAt.getTime() <= now.getTime() - leaseMs;
    if (this.status !== "PENDING" && !expired) return null;
    this.status = "PROCESSING"; this.claimedAt = now; this.attempts += 1; this.token = `claim-${this.attempts}`;
    return { id: "work-1", executionId: "execution-1", traceId: "trace-1", claimToken: this.token };
  }
  async complete(id: string, token: string, completedAt: Date) { void completedAt; if (id !== "work-1" || token !== this.token || this.status !== "PROCESSING") return false; this.status = "PUBLISHED"; return true; }
  async release(id: string, token: string, error: string) { void error; if (id !== "work-1" || token !== this.token || this.status !== "PROCESSING") return false; this.status = "PENDING"; return true; }
}

it("leases one recovery job and marks it complete only with the active claim", async () => {
  const work = new MemoryRecoveryStore(); let calls = 0;
  expect(await processNextRecovery(work, { async recover(executionId, traceId) { calls += 1; expect({ executionId, traceId }).toEqual({ executionId: "execution-1", traceId: "trace-1" }); return "RESOLVED"; } }, { now: new Date(0) })).toBe("RESOLVED");
  expect(calls).toBe(1); expect(work.status).toBe("PUBLISHED");
});

it("releases unresolved recovery for retry and reclaims an expired lease safely", async () => {
  const work = new MemoryRecoveryStore(); const first = await work.claimNext(new Date(0), 1_000); expect(first).not.toBeNull(); expect(await work.claimNext(new Date(500), 1_000)).toBeNull(); const reclaimed = await work.claimNext(new Date(1_001), 1_000); expect(reclaimed?.claimToken).not.toBe(first?.claimToken);
  expect(await work.complete("work-1", first!.claimToken, new Date())).toBe(false);
  await work.release("work-1", reclaimed!.claimToken, "retry");
  expect(await processNextRecovery(work, { async recover() { return "RETRY"; } })).toBe("RETRY"); expect(work.status).toBe("PENDING");
});
