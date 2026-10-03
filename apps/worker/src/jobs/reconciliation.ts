export type ReconciliationStatus = "PENDING" | "SETTLED" | "FAILED" | "UNKNOWN";
export interface PersistedExecutionEvidence { executionState: string; steps: Array<{ status: string; bankReference?: string }> }
export interface ReconciliationStore { loadExecution(executionId: string): Promise<PersistedExecutionEvidence | null> }
export interface BankEvidenceVerifier { verify(bankReference: string): Promise<ReconciliationStatus> }
export interface ClaimedRecoveryWork { id: string; executionId: string; traceId: string; claimToken: string }
export interface RecoveryWorkStore {
  claimNext(now: Date, leaseMs: number): Promise<ClaimedRecoveryWork | null>;
  complete(id: string, claimToken: string, completedAt: Date): Promise<boolean>;
  release(id: string, claimToken: string, error: string): Promise<boolean>;
}
export interface ExecutionRecoveryPort { recover(executionId: string, traceId: string): Promise<"RESOLVED" | "RETRY"> }
interface RecoverySqlClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}
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

export class PrismaRecoveryWorkStore implements RecoveryWorkStore {
  constructor(private readonly db: RecoverySqlClient, private readonly newClaimToken: () => string) {}
  async claimNext(now: Date, leaseMs: number): Promise<ClaimedRecoveryWork | null> {
    const expiredBefore = new Date(now.getTime() - leaseMs); const claimToken = this.newClaimToken();
    const rows = await this.db.$queryRaw<Array<{ id: string; executionId: string; traceId: string }>>`
      WITH candidate AS (
        SELECT id FROM "OutboxEvent"
        WHERE topic = 'EXECUTION_STEP_UPDATED'
          AND payload->>'status' = 'UNKNOWN'
          AND payload->>'errorCode' IN ('BANK_RESPONSE_OUTCOME_UNKNOWN', 'BANK_LOOKUP_UNAVAILABLE')
          AND (status = 'PENDING' OR (status = 'PROCESSING' AND ("claimedAt" IS NULL OR "claimedAt" < ${expiredBefore})))
        ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "OutboxEvent" AS event
      SET status = 'PROCESSING', "claimToken" = ${claimToken}, "claimedAt" = ${now}, attempts = event.attempts + 1, "lastError" = NULL, "updatedAt" = ${now}
      FROM candidate WHERE event.id = candidate.id
      RETURNING event.id, event."aggregateId" AS "executionId", event."traceId"
    `;
    return rows[0] ? { ...rows[0], claimToken } : null;
  }
  async complete(id: string, claimToken: string, completedAt: Date): Promise<boolean> {
    return await this.db.$executeRaw`UPDATE "OutboxEvent" SET status = 'PUBLISHED', "publishedAt" = ${completedAt}, "claimToken" = NULL, "claimedAt" = NULL, "lastError" = NULL, "updatedAt" = ${completedAt} WHERE id = ${id} AND status = 'PROCESSING' AND "claimToken" = ${claimToken}` === 1;
  }
  async release(id: string, claimToken: string, error: string): Promise<boolean> {
    const now = new Date(); return await this.db.$executeRaw`UPDATE "OutboxEvent" SET status = 'PENDING', "claimToken" = NULL, "claimedAt" = NULL, "lastError" = ${error.slice(0, 2_000)}, "updatedAt" = ${now} WHERE id = ${id} AND status = 'PROCESSING' AND "claimToken" = ${claimToken}` === 1;
  }
}

export async function processNextRecovery(store: RecoveryWorkStore, recovery: ExecutionRecoveryPort, options: { now?: Date; leaseMs?: number } = {}): Promise<"EMPTY" | "RESOLVED" | "RETRY"> {
  const work = await store.claimNext(options.now ?? new Date(), options.leaseMs ?? 30_000); if (!work) return "EMPTY";
  try {
    const outcome = await recovery.recover(work.executionId, work.traceId);
    if (outcome === "RETRY") { await store.release(work.id, work.claimToken, "BANK_OUTCOME_STILL_UNKNOWN"); return "RETRY"; }
    if (!await store.complete(work.id, work.claimToken, new Date())) throw new Error("RECOVERY_CLAIM_LOST");
    return "RESOLVED";
  } catch (error) {
    await store.release(work.id, work.claimToken, error instanceof Error ? error.message : "RECOVERY_FAILED"); return "RETRY";
  }
}
