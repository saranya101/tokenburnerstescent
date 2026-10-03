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
import { hashFinancialPlan } from "../security/canonical-hash.js";
import {
  evaluateRisk,
  extractPlanRiskExposures,
} from "./evaluator.js";

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

function normalizedExposures(
  exposures: Array<{
    stepId: string;
    action: string;
    currency: string;
    minorUnits: string;
  }>,
) {
  return exposures
    .map((exposure) => ({ ...exposure }))
    .sort((a, b) =>
      a.stepId.localeCompare(b.stepId) ||
      a.action.localeCompare(b.action) ||
      a.currency.localeCompare(b.currency) ||
      a.minorUnits.localeCompare(b.minorUnits),
    );
}

function exposuresEqual(
  left: Parameters<typeof normalizedExposures>[0],
  right: Parameters<typeof normalizedExposures>[0],
) {
  return JSON.stringify(normalizedExposures(left)) ===
    JSON.stringify(normalizedExposures(right));
}

function velocityUsage(
  rows: Array<{
    reservationId: string;
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
  const reservationCurrencies = new Map<
    string,
    { currency: string; hasReserved: boolean; hasSettled: boolean }
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
    }

    if (row.status === "RESERVED") {
      current.reservedAmount += row.minorUnits;
    }

    values.set(row.currency, current);

    const key = `${row.reservationId}\0${row.currency}`;
    const classification = reservationCurrencies.get(key) ?? {
      currency: row.currency,
      hasReserved: false,
      hasSettled: false,
    };

    if (row.status === "RESERVED") classification.hasReserved = true;
    if (row.status === "SETTLED") classification.hasSettled = true;
    reservationCurrencies.set(key, classification);
  }

  for (const classification of reservationCurrencies.values()) {
    const current = values.get(classification.currency)!;

    if (classification.hasReserved) {
      current.reservedCount += 1;
    } else if (classification.hasSettled) {
      current.settledCount += 1;
    }
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

            if (hashFinancialPlan(plan) !== plan.planHash) {
              throw new Error("RISK_PLAN_BINDING_INVALID");
            }

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

              await tx.auditEvent.createMany({
                data: staleIds.map((reservationId) => ({
                  eventType: "RISK_RESERVATION_EXPIRED",
                  aggregateType: "RiskReservation",
                  aggregateId: reservationId,
                  traceId: input.traceId,
                  payload: json({
                    reservationId,
                    expiredAt: now.toISOString(),
                  }),
                })),
              });
            }

            // Idempotent within an already active reservation:
            // repeated requests for the same exact plan do not reserve twice.
            const existing = await tx.riskReservation.findFirst({
              where: {
                userId: input.userId,
                financialPlanId: plan.id,
                status: { in: ["ACTIVE", "EXECUTING"] },
                OR: [
                  { status: "EXECUTING" },
                  { status: "ACTIVE", expiresAt: { gt: now } },
                ],
              },
              include: {
                assessment: true,
                entries: true,
              },
            });

            if (existing) {
              if (
                existing.financialPlanHash !== plan.planHash ||
                existing.policyVersion !== policy.policyVersion
              ) {
                throw new Error("RISK_LIVE_RESERVATION_CONFLICT");
              }

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
                      OR: [
                        { status: "EXECUTING" },
                        {
                          status: "ACTIVE",
                          expiresAt: { gt: now },
                        },
                      ],
                    },
                  },
                ],
              },

              select: {
                reservationId: true,
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

  async getActiveReservation(input: {
    userId: string;
    financialPlanId: string;
    financialPlanHash: string;
    policyVersion: string;
    now?: Date;
  }): Promise<RiskReservation | null> {
    const now = input.now ?? new Date();

    const row = await this.db.riskReservation.findFirst({
      where: {
        userId: input.userId,
        financialPlanId: input.financialPlanId,
        financialPlanHash: input.financialPlanHash,
        policyVersion: input.policyVersion,
        OR: [
          { status: "EXECUTING" },
          { status: "ACTIVE", expiresAt: { gt: now } },
        ],
      },
      include: {
        assessment: true,
        entries: true,
      },
    });

    return row ? mapReservation(row) : null;
  }

  async validateStepForExecution(input: {
    userId: string;
    financialPlanId: string;
    financialPlanHash: string;
    policy: RiskPolicy;
    stepId: string;
    traceId: string;
    now?: Date;
  }): Promise<RiskReservation> {
    const policy = RiskPolicyV1.parse(input.policy);
    const now = input.now ?? new Date();

    if (Date.parse(policy.effectiveAt) > now.getTime()) {
      throw new Error("RISK_POLICY_UNAVAILABLE");
    }

    return this.db.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "User"
          WHERE "id" = ${input.userId}
          FOR UPDATE
        `;

        if (locked.length !== 1) {
          throw new Error("RISK_USER_NOT_FOUND");
        }

        const profile = await tx.userRiskProfile.findUnique({
          where: { userId: input.userId },
        });

        if (!profile) {
          throw new Error("RISK_PROFILE_UNAVAILABLE");
        }

        if (profile.kycStatus === "BLOCKED") {
          throw new Error("RISK_KYC_BLOCKED");
        }

        if (profile.kycStatus === "REVIEW_REQUIRED") {
          throw new Error("RISK_KYC_REVIEW_REQUIRED");
        }

        const planRow = await tx.financialPlan.findUnique({
          where: { id: input.financialPlanId },
          include: {
            steps: true,
            goalContract: { select: { userId: true } },
            goalBundle: { select: { userId: true } },
          },
        });

        if (!planRow || planRow.status !== "READY") {
          throw new Error("RISK_FINANCIAL_PLAN_NOT_READY");
        }

        const ownerUserId =
          planRow.goalContract?.userId ?? planRow.goalBundle?.userId;
        const exactlyOneOwner =
          (planRow.goalContract !== null) !==
          (planRow.goalBundle !== null);

        if (!exactlyOneOwner || ownerUserId !== input.userId) {
          throw new Error("RISK_PLAN_BINDING_INVALID");
        }

        const plan = mapPlan(planRow);

        if (
          plan.id !== input.financialPlanId ||
          plan.planHash !== input.financialPlanHash ||
          hashFinancialPlan(plan) !== plan.planHash
        ) {
          throw new Error("RISK_PLAN_BINDING_INVALID");
        }

        let expectedExposures;

        try {
          expectedExposures = extractPlanRiskExposures(plan);
        } catch {
          throw new Error("RISK_EXPOSURE_UNPROVABLE");
        }

        const reservation =
          await tx.riskReservation.findFirst({
            where: {
              userId: input.userId,
              financialPlanId: input.financialPlanId,
              financialPlanHash: input.financialPlanHash,
              OR: [
                { status: "EXECUTING" },
                { status: "ACTIVE", expiresAt: { gt: now } },
              ],
            },
            include: {
              assessment: true,
              entries: true,
            },
          });

        if (!reservation) {
          throw new Error("RISK_RESERVATION_NOT_ACTIVE");
        }

        if (reservation.policyVersion !== policy.policyVersion) {
          throw new Error("RISK_POLICY_CHANGED");
        }

        if (
          reservation.userId !== input.userId ||
          reservation.assessment.decision !== "ALLOW" ||
          reservation.assessment.userId !== input.userId ||
          reservation.assessment.financialPlanId !==
            input.financialPlanId ||
          reservation.assessment.financialPlanHash !==
            input.financialPlanHash ||
          reservation.assessment.policyVersion !==
            policy.policyVersion ||
          reservation.assessment.bankStateVersion !==
            plan.bankStateVersion
        ) {
          throw new Error("RISK_RESERVATION_BINDING_INVALID");
        }

        const persistedExposures = reservation.entries.map((item) => ({
          stepId: item.stepId,
          action: item.action,
          currency: item.currency,
          minorUnits: item.minorUnits.toString(),
        }));
        const assessment = mapAssessment(reservation.assessment);

        if (
          !exposuresEqual(expectedExposures, persistedExposures) ||
          !exposuresEqual(expectedExposures, assessment.exposures)
        ) {
          throw new Error("RISK_RESERVATION_BINDING_INVALID");
        }

        const entry = reservation.entries.find(
          (item) => item.stepId === input.stepId,
        );
        const expectedEntry = expectedExposures.find(
          (item) => item.stepId === input.stepId,
        );

        if (
          !entry ||
          !expectedEntry ||
          entry.status !== "RESERVED" ||
          entry.action !== expectedEntry.action ||
          entry.currency !== expectedEntry.currency ||
          entry.minorUnits.toString() !== expectedEntry.minorUnits
        ) {
          throw new Error("RISK_STEP_NOT_RESERVED");
        }

        if (reservation.status === "ACTIVE") {
          const claimed = await tx.riskReservation.updateMany({
            where: { id: reservation.id, status: "ACTIVE" },
            data: { status: "EXECUTING" },
          });

          if (claimed.count !== 1) {
            throw new Error("RISK_RESERVATION_CLAIM_FAILED");
          }

          await tx.auditEvent.create({
            data: {
              eventType: "RISK_RESERVATION_EXECUTION_CLAIMED",
              aggregateType: "RiskReservation",
              aggregateId: reservation.id,
              traceId: input.traceId,
              payload: json({
                reservationId: reservation.id,
                financialPlanId: plan.id,
                financialPlanHash: plan.planHash,
                policyVersion: policy.policyVersion,
                claimedAt: now.toISOString(),
              }),
            },
          });
        }

        const updated =
          await tx.riskReservation.findUniqueOrThrow({
            where: { id: reservation.id },
            include: {
              assessment: true,
              entries: true,
            },
          });

        return mapReservation(updated);
      },
      {
        isolationLevel:
          Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  async settleStepForPlan(input: {
    userId: string;
    financialPlanId: string;
    financialPlanHash: string;
    policyVersion: string;
    stepId: string;
    traceId: string;
    now?: Date;
  }): Promise<RiskReservation> {
    const now = input.now ?? new Date();

    const reservation = await this.db.riskReservation.findFirst({
      where: {
        userId: input.userId,
        financialPlanId: input.financialPlanId,
        financialPlanHash: input.financialPlanHash,
        policyVersion: input.policyVersion,
        status: { in: ["EXECUTING", "CONSUMED"] },
        entries: {
          some: {
            stepId: input.stepId,
            status: { in: ["RESERVED", "SETTLED"] },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      include: {
        assessment: true,
        entries: true,
      },
    });

    if (!reservation) {
      throw new Error("RISK_RESERVATION_NOT_FOUND");
    }

    const entry = reservation.entries.find(
      (item) => item.stepId === input.stepId,
    );

    if (!entry) {
      throw new Error("RISK_STEP_NOT_RESERVED");
    }

    // Reconciliation/restart safety:
    // if this exact financial effect was already accounted as SETTLED,
    // return the same authoritative reservation instead of double counting it.
    if (entry.status === "SETTLED") {
      return mapReservation(reservation);
    }

    return this.settleStep({
      reservationId: reservation.id,
      userId: input.userId,
      financialPlanId: input.financialPlanId,
      financialPlanHash: input.financialPlanHash,
      policyVersion: input.policyVersion,
      stepId: input.stepId,
      traceId: input.traceId,
      now,
    });
  }

  async releaseActiveForPlan(input: {
    userId: string;
    financialPlanId: string;
    financialPlanHash: string;
    policyVersion: string;
    traceId: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();

    const reservation =
      await this.db.riskReservation.findFirst({
        where: {
          userId: input.userId,
          financialPlanId: input.financialPlanId,
          financialPlanHash: input.financialPlanHash,
          status: { in: ["ACTIVE", "EXECUTING"] },
        },
        select: { id: true, policyVersion: true },
      });

    if (!reservation) {
      return false;
    }

    return this.release({
      reservationId: reservation.id,
      userId: input.userId,
      financialPlanId: input.financialPlanId,
      financialPlanHash: input.financialPlanHash,
      policyVersion: reservation.policyVersion,
      traceId: input.traceId,
      now,
    });
  }

  async settleStep(input: {
    reservationId: string;
    userId: string;
    financialPlanId: string;
    financialPlanHash: string;
    policyVersion: string;
    stepId: string;
    traceId: string;
    now?: Date;
  }): Promise<RiskReservation> {
    const now = input.now ?? new Date();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.db.$transaction(
          async (tx) => {
        const reservation = await tx.riskReservation.findUnique({
          where: { id: input.reservationId },
          include: {
            assessment: true,
            entries: true,
          },
        });

        if (
          !reservation ||
          reservation.userId !== input.userId ||
          reservation.financialPlanId !== input.financialPlanId ||
          reservation.financialPlanHash !== input.financialPlanHash ||
          reservation.policyVersion !== input.policyVersion
        ) {
          throw new Error("RISK_RESERVATION_BINDING_INVALID");
        }

        const entry = reservation.entries.find(
          (item) => item.stepId === input.stepId,
        );

        if (entry?.status === "SETTLED") {
          return mapReservation(reservation);
        }

        if (
          reservation.status !== "EXECUTING" ||
          entry?.status !== "RESERVED"
        ) {
          throw new Error("RISK_RESERVATION_NOT_ACTIVE");
        }

        const settled = await tx.riskVelocityEntry.updateMany({
          where: {
            reservationId: input.reservationId,
            stepId: input.stepId,
            status: "RESERVED",
          },
          data: {
            status: "SETTLED",
            settledAt: now,
          },
        });

        if (settled.count !== 1) {
          throw new Error("RISK_STEP_NOT_RESERVED");
        }

        await tx.auditEvent.create({
          data: {
            eventType: "RISK_EXPOSURE_SETTLED",
            aggregateType: "RiskReservation",
            aggregateId: input.reservationId,
            traceId: input.traceId,
            payload: json({
              reservationId: input.reservationId,
              financialPlanId: input.financialPlanId,
              stepId: input.stepId,
              settledAt: now.toISOString(),
            }),
          },
        });

        const remaining = await tx.riskVelocityEntry.count({
          where: {
            reservationId: input.reservationId,
            status: "RESERVED",
          },
        });

        if (remaining === 0) {
          await tx.riskReservation.update({
            where: { id: input.reservationId },
            data: {
              status: "CONSUMED",
              consumedAt: now,
            },
          });

          await tx.auditEvent.create({
            data: {
              eventType: "RISK_RESERVATION_CONSUMED",
              aggregateType: "RiskReservation",
              aggregateId: input.reservationId,
              traceId: input.traceId,
              payload: json({
                reservationId: input.reservationId,
                financialPlanId: input.financialPlanId,
                consumedAt: now.toISOString(),
              }),
            },
          });
        }

        const updated = await tx.riskReservation.findUniqueOrThrow({
          where: { id: input.reservationId },
          include: {
            assessment: true,
            entries: true,
          },
        });

        return mapReservation(updated);
          },
          {
            isolationLevel:
              Prisma.TransactionIsolationLevel.Serializable,
          },
        );
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034";

        if (retryable && attempt < 2) continue;
        throw error;
      }
    }

    throw new Error("RISK_SETTLEMENT_RETRY_EXHAUSTED");
  }

  async release(input: {
    reservationId: string;
    userId: string;
    financialPlanId: string;
    financialPlanHash: string;
    policyVersion: string;
    traceId: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();

    return this.db.$transaction(
      async (tx) => {
        const reservation = await tx.riskReservation.findUnique({
          where: { id: input.reservationId },
          include: { entries: true },
        });

        if (!reservation) {
          return false;
        }

        if (
          reservation.userId !== input.userId ||
          reservation.financialPlanId !== input.financialPlanId ||
          reservation.financialPlanHash !== input.financialPlanHash ||
          reservation.policyVersion !== input.policyVersion
        ) {
          throw new Error("RISK_RESERVATION_BINDING_INVALID");
        }

        if (!["ACTIVE", "EXECUTING"].includes(reservation.status)) {
          return false;
        }

        await tx.riskVelocityEntry.updateMany({
          where: {
            reservationId: input.reservationId,
            status: "RESERVED",
          },
          data: {
            status: "RELEASED",
            releasedAt: now,
          },
        });

        const hasSettledExposure = reservation.entries.some(
          (entry) => entry.status === "SETTLED",
        );
        const finalStatus = hasSettledExposure
          ? "CONSUMED"
          : "RELEASED";

        await tx.riskReservation.update({
          where: { id: input.reservationId },
          data: {
            status: finalStatus,
            ...(hasSettledExposure ? { consumedAt: now } : {}),
            releasedAt: now,
          },
        });

        await tx.auditEvent.create({
          data: {
            eventType: "RISK_RESERVATION_RELEASED",
            aggregateType: "RiskReservation",
            aggregateId: input.reservationId,
            traceId: input.traceId,
            payload: json({
              reservationId: input.reservationId,
              financialPlanId: input.financialPlanId,
              finalStatus,
              releasedAt: now.toISOString(),
            }),
          },
        });

        if (hasSettledExposure) {
          await tx.auditEvent.create({
            data: {
              eventType: "RISK_RESERVATION_CONSUMED",
              aggregateType: "RiskReservation",
              aggregateId: input.reservationId,
              traceId: input.traceId,
              payload: json({
                reservationId: input.reservationId,
                financialPlanId: input.financialPlanId,
                consumedAt: now.toISOString(),
                reason: "PARTIAL_EXECUTION_FINALIZED",
              }),
            },
          });
        }

        return true;
      },
      {
        isolationLevel:
          Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }
}
