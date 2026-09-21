export type ReconciliationStatus = "PENDING" | "SETTLED" | "FAILED" | "UNKNOWN";
export interface PersistedExecutionEvidence { executionState: string; steps: Array<{ status: string; bankReference?: string }> }
export interface ReconciliationStore { loadExecution(executionId: string): Promise<PersistedExecutionEvidence | null> }
export interface BankEvidenceVerifier { verify(bankReference: string): Promise<ReconciliationStatus> }
interface ReconciliationDb { executionRun: { findUnique(input: unknown): Promise<{ status: string; steps: Array<{ status: string; bankReference: string | null }> } | null> } }

export class PrismaReconciliationStore implements ReconciliationStore {
  constructor(private readonly db: ReconciliationDb) {}
  async loadExecution(executionId: string): Promise<PersistedExecutionEvidence | null> {
    const row = await this.db.executionRun.findUnique({ where: { id: executionId }, select: { status: true, steps: { select: { status: true, bankReference: true } } } });
    return row ? { executionState: row.status, steps: row.steps.map((step) => ({ status: step.status, ...(step.bankReference ? { bankReference: step.bankReference } : {}) })) } : null;
  }
}

export async function reconcilePersistedExecution(executionId: string, store: ReconciliationStore, bank: BankEvidenceVerifier): Promise<ReconciliationStatus> {
  const execution = await store.loadExecution(executionId); if (!execution) return "UNKNOWN";
  if (execution.executionState === "FAILED" || execution.steps.some((step) => step.status === "FAILED")) return "FAILED";
  if (execution.steps.length === 0 || execution.steps.some((step) => step.status === "PENDING" && !step.bankReference)) return "PENDING";
  const evidence: ReconciliationStatus[] = [];
  for (const step of execution.steps) evidence.push(step.bankReference ? await bank.verify(step.bankReference) : "UNKNOWN");
  if (evidence.includes("FAILED")) return "FAILED"; if (evidence.includes("UNKNOWN")) return "UNKNOWN"; if (evidence.includes("PENDING")) return "PENDING";
  return evidence.every((status) => status === "SETTLED") ? "SETTLED" : "UNKNOWN";
}
