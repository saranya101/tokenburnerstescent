import { expect, it } from "vitest";
import { reconcilePersistedExecution, type PersistedExecutionEvidence } from "./reconciliation.js";

const store = (evidence: PersistedExecutionEvidence | null) => ({ async loadExecution() { return evidence; } });
const bank = (statuses: Record<string, "PENDING" | "SETTLED" | "FAILED" | "UNKNOWN">) => ({ async verify(reference: string) { return statuses[reference] ?? "UNKNOWN" as const; } });

it("does not infer settlement without bank-verifiable evidence", async () => { expect(await reconcilePersistedExecution("run", store({ executionState: "EXECUTING", steps: [{ status: "ACCEPTED" }] }), bank({}))).toBe("UNKNOWN"); });
it("classifies persisted pending and failed states without financial retries", async () => { expect(await reconcilePersistedExecution("run", store({ executionState: "AUTHORIZED", steps: [] }), bank({}))).toBe("PENDING"); expect(await reconcilePersistedExecution("run", store({ executionState: "FAILED", steps: [] }), bank({}))).toBe("FAILED"); });
it("reports settled only when every persisted step is bank-verified", async () => { const evidence = { executionState: "COMPLETED", steps: [{ status: "SETTLED", bankReference: "a" }, { status: "SETTLED", bankReference: "b" }] }; expect(await reconcilePersistedExecution("run", store(evidence), bank({ a: "SETTLED", b: "SETTLED" }))).toBe("SETTLED"); expect(await reconcilePersistedExecution("run", store(evidence), bank({ a: "SETTLED", b: "PENDING" }))).toBe("PENDING"); });
