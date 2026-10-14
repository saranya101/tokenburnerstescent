import type { PrismaClient } from "@parlance/db";

export class PrismaCustomerOperationsReadService {
  constructor(private readonly db: PrismaClient) {}

  async list(userId: string) {
    const rows = await this.db.executionRun.findMany({
      where: { userId }, orderBy: { updatedAt: "desc" }, take: 20,
      select: { id: true, planId: true, status: true, createdAt: true, updatedAt: true, finalStateVersion: true,
        steps: { select: { status: true, bankReference: true, errorCode: true, planStep: { select: { action: true, sequence: true } } }, orderBy: { planStep: { sequence: "asc" } } } },
    });
    return { items: rows.map((row) => ({
      executionId: row.id, planId: row.planId, status: row.status, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      ...(row.finalStateVersion === null ? {} : { finalStateVersion: row.finalStateVersion }),
      steps: row.steps.map((step) => ({ action: step.planStep.action, status: step.status, ...(step.bankReference ? { bankReference: step.bankReference } : {}), ...(step.errorCode ? { errorCode: step.errorCode } : {}) })),
    })) };
  }
}
