import { randomUUID } from "node:crypto";

interface SqlClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface ClaimedOutboxEvent { id: string; topic: string; aggregateId: string; traceId: string; payload: unknown; attempts: number; claimToken: string }
export interface OutboxStore {
  claimNext(now: Date, leaseMs: number): Promise<ClaimedOutboxEvent | null>;
  markPublished(id: string, claimToken: string, publishedAt: Date): Promise<boolean>;
  releaseForRetry(id: string, claimToken: string, error: string): Promise<boolean>;
}
export interface OutboxPublisher { publish(event: ClaimedOutboxEvent): Promise<void> }

export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly db: SqlClient) {}
  async claimNext(now: Date, leaseMs: number): Promise<ClaimedOutboxEvent | null> {
    const expiredBefore = new Date(now.getTime() - leaseMs); const claimToken = randomUUID();
    const rows = await this.db.$queryRaw<Array<{ id: string; topic: string; aggregateId: string; traceId: string; payload: unknown; attempts: number }>>`
      WITH candidate AS (
        SELECT id FROM "OutboxEvent"
        WHERE status = 'PENDING' OR (status = 'PROCESSING' AND ("claimedAt" IS NULL OR "claimedAt" < ${expiredBefore}))
        ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "OutboxEvent" AS event
      SET status = 'PROCESSING', "claimToken" = ${claimToken}, "claimedAt" = ${now}, attempts = event.attempts + 1, "lastError" = NULL, "updatedAt" = ${now}
      FROM candidate WHERE event.id = candidate.id
      RETURNING event.id, event.topic, event."aggregateId", event."traceId", event.payload, event.attempts
    `;
    const row = rows[0]; return row ? { ...row, claimToken } : null;
  }
  async markPublished(id: string, claimToken: string, publishedAt: Date): Promise<boolean> { const count = await this.db.$executeRaw`UPDATE "OutboxEvent" SET status = 'PUBLISHED', "publishedAt" = ${publishedAt}, "claimToken" = NULL, "claimedAt" = NULL, "lastError" = NULL, "updatedAt" = ${publishedAt} WHERE id = ${id} AND status = 'PROCESSING' AND "claimToken" = ${claimToken}`; return count === 1; }
  async releaseForRetry(id: string, claimToken: string, error: string): Promise<boolean> { const now = new Date(); const count = await this.db.$executeRaw`UPDATE "OutboxEvent" SET status = 'PENDING', "claimToken" = NULL, "claimedAt" = NULL, "lastError" = ${error.slice(0, 2_000)}, "updatedAt" = ${now} WHERE id = ${id} AND status = 'PROCESSING' AND "claimToken" = ${claimToken}`; return count === 1; }
}

export async function processNextOutboxEvent(store: OutboxStore, publisher: OutboxPublisher, options: { now?: Date; leaseMs?: number } = {}): Promise<"EMPTY" | "PUBLISHED" | "RETRY"> {
  const event = await store.claimNext(options.now ?? new Date(), options.leaseMs ?? 30_000); if (!event) return "EMPTY";
  try { await publisher.publish(event); if (!await store.markPublished(event.id, event.claimToken, new Date())) throw new Error("OUTBOX_CLAIM_LOST"); return "PUBLISHED"; }
  catch (error) { await store.releaseForRetry(event.id, event.claimToken, error instanceof Error ? error.message : "OUTBOX_PUBLISH_FAILED"); return "RETRY"; }
}
