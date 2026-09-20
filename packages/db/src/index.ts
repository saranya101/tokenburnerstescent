export interface ExecutionTransitionInput { executionId: string; nextStatus: string; auditType: string; traceId: string; payload: Record<string, unknown>; outboxTopic: string; }
export interface TransactionalWriter {
  updateExecution(id: string, status: string): Promise<void>;
  appendAudit(event: { type: string; aggregateId: string; traceId: string; payload: Record<string, unknown> }): Promise<void>;
  insertOutbox(event: { topic: string; aggregateId: string; traceId: string; payload: Record<string, unknown> }): Promise<void>;
}
export interface TransactionRunner { transaction<T>(work: (writer: TransactionalWriter) => Promise<T>): Promise<T>; }
export function transitionExecutionWithOutbox(db: TransactionRunner, input: ExecutionTransitionInput): Promise<void> {
  return db.transaction(async (tx) => {
    await tx.updateExecution(input.executionId, input.nextStatus);
    await tx.appendAudit({ type: input.auditType, aggregateId: input.executionId, traceId: input.traceId, payload: input.payload });
    await tx.insertOutbox({ topic: input.outboxTopic, aggregateId: input.executionId, traceId: input.traceId, payload: input.payload });
  });
}
