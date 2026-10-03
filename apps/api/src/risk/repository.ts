import { randomUUID } from "node:crypto";
import {
  FinancialPlanV1,
  RiskAssessmentV1,
  RiskPolicyV1,
  RiskReservationV1,
  RiskVelocityUsageV1,
  type RiskAssessmentV1 as RiskAssessment,
  type RiskPolicyV1 as RiskPolicy,
  type RiskReservationV1 as RiskReservation,
  type RiskVelocityUsageV1 as RiskVelocityUsage,
} from "@parlance/contracts";
import { Prisma, type PrismaClient } from "@parlance/db";
import { evaluateRisk } from "./evaluator.js";

export type RiskReserveResult = {
  assessment: RiskAssessment;
  reservation?: RiskReservation;
};

export type ReserveRiskInput = {
  userId: string;
  financialPlanId: string;
  policy: RiskPolicy;
  traceId: string;
  now?: Date;
};

type PlanRow = Prisma.FinancialPlanGetPayload<{
  include: {
    steps: true;
    goalContract: { select: { userId: true } };
    goalBundle: { select: { userId: true } };
  };
}>;

type ReservationRow = Prisma.RiskReservationGetPayload<{
  include: {
    assessment: true;
    entries: true;
  };
}>;

const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

function mapPlan(row: PlanRow) {
  return FinancialPlanV1.parse({
    schemaVersion: row.schemaVersion,
    id: row.id,
    goalContractId: row.goalContractKey,
    goalContractVersion: row.goalContractVersion,
    bankStateVersion: row.bankStateVersion,
    compilerVersion: row.compilerVersion,
    policyVersion: row.policyVersion,
    operationLibraryVersion: row.operationLibraryVersion,

    steps: [...row.steps]
      .sort((a, b) => a.sequence - b.sequence)
      .map((step) => ({
        id: step.stepKey,
        sequence: step.sequence,
        action: step.action,
        dependsOn: step.dependsOn,
        reversible: step.reversible,
        parameters: step.parameters,
      })),

    validity: row.validity,
    projectedOutcome: row.projectedOutcome,
    planHash: row.planHash,
  });
}

function mapAssessment(
  row: Prisma.RiskAssessmentGetPayload<Record<string, never>>,
): RiskAssessment {
  return RiskAssessmentV1.parse({
    schemaVersion: "1",
    id: row.id,
    userId: row.userId,
    financialPlanId: row.financialPlanId,
    financialPlanHash: row.financialPlanHash,
    bankStateVersion: row.bankStateVersion,
    policyVersion: row.policyVersion,
    kycStatus: row.kycStatus,
    decision: row.decision,
    reasonCodes: row.reasonCodes,
    exposures: row.exposures,
    rollingUsage: row.rollingUsage,
    assessedAt: row.assessedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  });
}

function mapReservation(row: ReservationRow): RiskReservation {
  return RiskReservationV1.parse({
    schemaVersion: "1",
    id: row.id,
    userId: row.userId,
    assessmentId: row.assessmentId,
    financialPlanId: row.financialPlanId,
    financialPlanHash: row.financialPlanHash,
    policyVersion: row.policyVersion,

    exposures: row.entries.map((entry) => ({
      stepId: entry.stepId,
      action: entry.action,
      currency: entry.currency,
      minorUnits: entry.minorUnits.toString(),
    })),

    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),

    ...(row.consumedAt
      ? { consumedAt: row.consumedAt.toISOString() }
      : {}),

    ...(row.releasedAt
      ? { releasedAt: row.releasedAt.toISOString() }
      : {}),
  });
}

function velocityUsage(
  rows: Array<{
    currency: string;
    minorUnits: bigint;
    status: "RESERVED" | "SETTLED" | "RELEASED" | "EXPIRED";
  }>,
  policy: RiskPolicy,
  now: Date,
): RiskVelocityUsage[] {
  const values = new Map<
    string,
    {
      settledAmount: bigint;
      reservedAmount: bigint;
      settledCount: number;
      reservedCount: number;
    }
  >();

  for (const row of rows) {
    const current = values.get(row.currency) ?? {
      settledAmount: 0n,
      reservedAmount: 0n,
      settledCount: 0,
      reservedCount: 0,
    };

    if (row.status === "SETTLED") {
      current.settledAmount += row.minorUnits;
      current.settledCount += 1;
    }

    if (row.status === "RESERVED") {
      current.reservedAmount += row.minorUnits;
      current.reservedCount += 1;
    }

    values.set(row.currency, current);
  }

  const windowEnd = now;
  const windowStart = new Date(
    now.getTime() - policy.rollingWindowSeconds * 1000,
  );

  return [...values.entries()].map(([currency, value]) =>
    RiskVelocityUsageV1.parse({
      currency,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),

      settledAmountMinorUnits: value.settledAmount.toString(),
      reservedAmountMinorUnits: value.reservedAmount.toString(),

      settledTransactionCount: value.settledCount,
      reservedTransactionCount: value.reservedCount,
    }),
  );
}

export class PrismaRiskRepository {
  constructor(private readonly db: PrismaClient) {}

  async reserve(input: ReserveRiskInput): Promise<RiskReserveResult> {
    const policy = RiskPolicyV1.parse(input.policy);
    const now = input.now ?? new Date();

    const assessmentId = randomUUID();
    const reservationId = randomUUID();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.db.$transaction(
          async (tx) => {
            // Serialize all risk reservations for one customer.
            // This prevents two simultaneous plans from independently
            // observing the same remaining velocity allowance.
            const locked = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "User"
              WHERE "id" = ${input.userId}
              FOR UPDATE
            `;

            if (locked.length !== 1) {
              throw new Error("RISK_USER_NOT_FOUND");
            }

            const planRow = await tx.financialPlan.findUnique({
              where: { id: input.financialPlanId },
              include: {
                steps: true,
                goalContract: {
                  select: { userId: true },
                },
                goalBundle: {
                  select: { userId: true },
                },
              },
            });

            if (!planRow || planRow.status !== "READY") {
              throw new Error("RISK_FINANCIAL_PLAN_NOT_READY");
            }

            const ownerUserId =
              planRow.goalContract?.userId ??
              planRow.goalBundle?.userId;

            const exactlyOneOwner =
              (planRow.goalContract !== null) !==
              (planRow.goalBundle !== null);

            if (!exactlyOneOwner || ownerUserId !== input.userId) {
              throw new Error("RISK_PLAN_BINDING_INVALID");
            }

            const plan = mapPlan(planRow);

            // Expire stale reservations before calculating current velocity.
            const stale = await tx.riskReservation.findMany({
              where: {
                userId: input.userId,
                status: "ACTIVE",
                expiresAt: { lte: now },
              },
              select: { id: true },
            });

            const staleIds = stale.map((item) => item.id);

            if (staleIds.length > 0) {
              await tx.riskVelocityEntry.updateMany({
                where: {
                  reservationId: { in: staleIds },
                  status: "RESERVED",
                },
                data: {
                  status: "EXPIRED",
                  releasedAt: now,
                },
              });

              await tx.riskReservation.updateMany({
                where: {
                  id: { in: staleIds },
                  status: "ACTIVE",
                },
                data: {
                  status: "EXPIRED",
                  releasedAt: now,
                },
              });
            }

            // Idempotent within an already active reservation:
            // repeated requests for the same exact plan do not reserve twice.
            const existing = await tx.riskReservation.findFirst({
              where: {
                userId: input.userId,
                financialPlanId: plan.id,
                financialPlanHash: plan.planHash,
                policyVersion: policy.policyVersion,
                status: "ACTIVE",
                expiresAt: { gt: now },
              },
              include: {
                assessment: true,
                entries: true,
              },
            });

            if (existing) {
              return {
                assessment: mapAssessment(existing.assessment),
                reservation: mapReservation(existing),
              };
            }

            const profile = await tx.userRiskProfile.findUnique({
              where: { userId: input.userId },
            });

            if (!profile) {
              throw new Error("RISK_PROFILE_UNAVAILABLE");
            }

            const windowStart = new Date(
              now.getTime() -
                policy.rollingWindowSeconds * 1000,
            );

            const entries = await tx.riskVelocityEntry.findMany({
              where: {
                reservation: {
                  userId: input.userId,
                },

                OR: [
                  {
                    status: "SETTLED",
                    settledAt: {
                      gte: windowStart,
                      lte: now,
                    },
                  },
                  {
                    status: "RESERVED",
                    reservation: {
                      status: "ACTIVE",
                      expiresAt: { gt: now },
                    },
                  },
                ],
              },

              select: {
                currency: true,
                minorUnits: true,
                status: true,
              },
            });

            const rollingUsage = velocityUsage(
              entries,
              policy,
              now,
            );

            const assessment = evaluateRisk({
              assessmentId,
              userId: input.userId,
              plan,
              policy,
              kycStatus: profile.kycStatus,
              rollingUsage,
              now,
            });

            await tx.riskAssessment.create({
              data: {
                id: assessment.id,
                userId: assessment.userId,
                financialPlanId: assessment.financialPlanId,
                financialPlanHash:
                  assessment.financialPlanHash,
                bankStateVersion:
                  assessment.bankStateVersion,
                policyVersion: assessment.policyVersion,
                kycStatus: assessment.kycStatus,
                decision: assessment.decision,
                reasonCodes: json(assessment.reasonCodes),
                exposures: json(assessment.exposures),
                rollingUsage: json(assessment.rollingUsage),
                assessedAt: new Date(assessment.assessedAt),
                expiresAt: new Date(assessment.expiresAt),
                traceId: input.traceId,
              },
            });

            await tx.auditEvent.create({
              data: {
                eventType: "RISK_ASSESSED",
                aggregateType: "FinancialPlan",
                aggregateId: plan.id,
                traceId: input.traceId,
                payload: json({
                  assessmentId: assessment.id,
                  planHash: assessment.financialPlanHash,
                  bankStateVersion:
                    assessment.bankStateVersion,
                  policyVersion:
                    assessment.policyVersion,
                  decision: assessment.decision,
                  reasonCodes: assessment.reasonCodes,
                }),
              },
            });

            if (assessment.decision !== "ALLOW") {
              return { assessment };
            }

            const reservation =
              await tx.riskReservation.create({
                data: {
                  id: reservationId,
                  userId: input.userId,
                  assessmentId: assessment.id,
                  financialPlanId: plan.id,
                  financialPlanHash: plan.planHash,
                  policyVersion: policy.policyVersion,
                  status: "ACTIVE",
                  traceId: input.traceId,
                  expiresAt: new Date(
                    assessment.expiresAt,
                  ),

                  entries: {
                    create: assessment.exposures.map(
                      (exposure) => ({
                        stepId: exposure.stepId,
                        action: exposure.action,
                        currency: exposure.currency,
                        minorUnits: BigInt(
                          exposure.minorUnits,
                        ),
                        status: "RESERVED",
                      }),
                    ),
                  },
                },

                include: {
                  assessment: true,
                  entries: true,
                },
              });

            await tx.auditEvent.create({
              data: {
                eventType: "RISK_RESERVATION_CREATED",
                aggregateType: "FinancialPlan",
                aggregateId: plan.id,
                traceId: input.traceId,
                payload: json({
                  reservationId: reservation.id,
                  assessmentId: assessment.id,
                  financialPlanHash: plan.planHash,
                  policyVersion: policy.policyVersion,
                  expiresAt:
                    assessment.expiresAt,
                }),
              },
            });

            return {
              assessment,
              reservation: mapReservation(reservation),
            };
          },
          {
            isolationLevel:
              Prisma.TransactionIsolationLevel.Serializable,
          },
        );
      } catch (error) {
        const retryable =
          error instanceof
            Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034";

        if (retryable && attempt < 2) {
          continue;
        }

        throw error;
      }
    }

    throw new Error("RISK_RESERVATION_RETRY_EXHAUSTED");
  }
}
