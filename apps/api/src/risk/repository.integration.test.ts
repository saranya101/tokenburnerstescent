import { randomUUID } from "node:crypto";
import {
  FinancialPlanV1,
  RiskPolicyV1,
  type FinancialPlanV1 as FinancialPlan,
} from "@parlance/contracts";
import { PrismaClient } from "@parlance/db";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { PrismaParlanceRepository } from "../repositories/prisma.js";
import { hashFinancialPlan } from "../security/canonical-hash.js";
import { PrismaRiskRepository } from "./repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const policy = RiskPolicyV1.parse({
  schemaVersion: "1",
  policyVersion: "it-risk-v1",
  effectiveAt: "2026-10-03T00:00:00.000Z",
  rollingWindowSeconds: 86400,

  singleTransactionThresholds: [
    {
      currency: "USD",
      reviewAtMinorUnits: "900000",
      blockAtMinorUnits: "1000000",
    },
  ],

  rollingAmountThresholds: [
    {
      currency: "USD",
      reviewAtMinorUnits: "499999",
      blockAtMinorUnits: "500000",
    },
  ],

  rollingCountThreshold: {
    reviewAt: 100,
    blockAt: 200,
  },
});

const countPolicy = RiskPolicyV1.parse({
  ...policy,
  policyVersion: "it-risk-count-v1",
  rollingCountThreshold: {
    reviewAt: 2,
    blockAt: 3,
  },
});

describe.skipIf(!testDatabaseUrl)(
  "PostgreSQL risk reservations",
  () => {
    let db: PrismaClient;
    const createdUsers: string[] = [];

    beforeAll(() => {
      db = new PrismaClient({
        datasourceUrl: testDatabaseUrl!,
      });
    });

    async function createUser() {
      const userId = `it-risk-${randomUUID()}`;
      createdUsers.push(userId);

      await db.user.create({
        data: { id: userId },
      });

      await db.userRiskProfile.create({
        data: {
          userId,
          kycStatus: "VERIFIED",
          version: 1,
        },
      });

      return userId;
    }

    async function createPlan(
      userId: string,
      amountMinor: string,
      hashCharacter: string,
      exposures: Array<{ currency: string; minorUnits: string }> = [
        { currency: "USD", minorUnits: amountMinor },
      ],
    ): Promise<FinancialPlan> {
      const suffix = `${hashCharacter}-${randomUUID()}`;
      const goalRowId = `it-risk-goal-row-${suffix}`;
      const goalKey = `it-risk-goal-${suffix}`;
      const planId = `it-risk-plan-${suffix}`;

      await db.goalContract.create({
        data: {
          id: goalRowId,
          contractKey: goalKey,
          version: 1,
          userId,
          status: "CONFIRMED",
          schemaVersion: "1",

          goalPayload: {
            type: "DELIVER_MONEY",
            amount: exposures[0],
            recipientId: "ben-test",
          },

          preferences: [],
          contractHash: `goal-hash-${suffix}`,
          confirmedAt: new Date(
            "2026-10-03T00:00:00.000Z",
          ),
        },
      });

      const rawPlan = FinancialPlanV1.parse({
        schemaVersion: "1",
        id: planId,
        goalContractId: goalKey,
        goalContractVersion: 1,
        bankStateVersion: 7,
        compilerVersion: "it-risk",
        policyVersion: "compiler-policy-v1",
        operationLibraryVersion: "it-risk",

        steps: exposures.map((exposure, sequence) => ({
            id: `${planId}-step-${sequence}`,
            sequence,
            dependsOn: [],
            reversible: false,
            action: "TRANSFER",
            parameters: {
              sourceAccountId: `acc-${exposure.currency.toLowerCase()}`,
              beneficiaryId: "ben-test",
              amount: exposure,
            },
          })),

        validity: {
          requiredQuoteIds: [],
        },

        projectedOutcome: {
          goalSatisfied: true,
          deliveredMoney: exposures[0],
          acquiredAssets: [],
          paidObligationIds: [],
          projectedAvailableBalances: [],
          warnings: [],
        },

        planHash: "0".repeat(64),
      });
      const plan = FinancialPlanV1.parse({
        ...rawPlan,
        planHash: hashFinancialPlan(rawPlan),
      });

      const repository =
        new PrismaParlanceRepository(db);

      await repository.savePlan(
        goalRowId,
        plan,
        `it-risk-${suffix}`,
      );

      return plan;
    }

    afterAll(async () => {
      if (!db) return;

      for (const userId of createdUsers) {
        const reservations =
          await db.riskReservation.findMany({
            where: { userId },
            select: { id: true },
          });

        await db.riskVelocityEntry.deleteMany({
          where: {
            reservationId: {
              in: reservations.map((item) => item.id),
            },
          },
        });

        await db.riskReservation.deleteMany({
          where: { userId },
        });

        await db.riskAssessment.deleteMany({
          where: { userId },
        });

        await db.userRiskProfile.deleteMany({
          where: { userId },
        });

        const plans = await db.financialPlan.findMany({
          where: {
            goalContract: { userId },
          },
          select: { id: true },
        });

        await db.financialPlanStep.deleteMany({
          where: {
            planId: {
              in: plans.map((item) => item.id),
            },
          },
        });

        await db.financialPlan.deleteMany({
          where: {
            goalContract: { userId },
          },
        });

        await db.goalContract.deleteMany({
          where: { userId },
        });

        await db.user.deleteMany({
          where: { id: userId },
        });
      }

      await db.auditEvent.deleteMany({
        where: {
          traceId: { startsWith: "it-risk-" },
        },
      });

      await db.outboxEvent.deleteMany({
        where: {
          traceId: { startsWith: "it-risk-" },
        },
      });

      await db.$disconnect();
    }, 60_000);

    it(
      "permits only one concurrent reservation when the second would exceed velocity",
      async () => {
        const userId = await createUser();

        const planA = await createPlan(
          userId,
          "300000",
          "a",
        );

        const planB = await createPlan(
          userId,
          "300000",
          "b",
        );

        const repository =
          new PrismaRiskRepository(db);

        const now = new Date(
          "2026-10-03T12:00:00.000Z",
        );

        const [first, second] = await Promise.all([
          repository.reserve({
            userId,
            financialPlanId: planA.id,
            policy,
            traceId: `it-risk-${randomUUID()}`,
            now,
          }),

          repository.reserve({
            userId,
            financialPlanId: planB.id,
            policy,
            traceId: `it-risk-${randomUUID()}`,
            now,
          }),
        ]);

        expect(
          [first.assessment.decision, second.assessment.decision]
            .sort(),
        ).toEqual(["ALLOW", "BLOCK"]);

        const reservations =
          await db.riskReservation.findMany({
            where: {
              userId,
              status: "ACTIVE",
            },
          });

        expect(reservations).toHaveLength(1);

        const entries =
          await db.riskVelocityEntry.findMany({
            where: {
              reservation: { userId },
              status: "RESERVED",
            },
          });

        expect(entries).toHaveLength(1);

        expect(
          entries.reduce(
            (sum, entry) => sum + entry.minorUnits,
            0n,
          ),
        ).toBe(300000n);
      },
      15_000,
    );

    it(
      "does not double reserve the same exact plan",
      async () => {
        const userId = await createUser();

        const plan = await createPlan(
          userId,
          "10000",
          "c",
        );

        const repository =
          new PrismaRiskRepository(db);

        const now = new Date(
          "2026-10-03T12:00:00.000Z",
        );

        const first = await repository.reserve({
          userId,
          financialPlanId: plan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now,
        });

        const second = await repository.reserve({
          userId,
          financialPlanId: plan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now,
        });

        expect(first.assessment.decision).toBe("ALLOW");
        expect(second.assessment.decision).toBe("ALLOW");

        expect(first.reservation?.id).toBe(
          second.reservation?.id,
        );

        expect(
          await db.riskReservation.count({
            where: {
              userId,
              status: "ACTIVE",
            },
          }),
        ).toBe(1);

        expect(
          await db.riskVelocityEntry.count({
            where: {
              reservation: { userId },
              status: "RESERVED",
            },
          }),
        ).toBe(1);
      },
      15_000,
    );

    it(
      "enforces one live reservation per financial plan in PostgreSQL",
      async () => {
        const userId = await createUser();
        const plan = await createPlan(userId, "10000", "unique-live");
        const repository = new PrismaRiskRepository(db);
        const now = new Date("2026-10-03T12:00:00.000Z");
        await repository.reserve({
          userId,
          financialPlanId: plan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now,
        });

        const duplicateAssessmentId = `assessment-${randomUUID()}`;
        await db.riskAssessment.create({
          data: {
            id: duplicateAssessmentId,
            userId,
            financialPlanId: plan.id,
            financialPlanHash: plan.planHash,
            bankStateVersion: plan.bankStateVersion,
            policyVersion: policy.policyVersion,
            kycStatus: "VERIFIED",
            decision: "ALLOW",
            reasonCodes: [],
            exposures: [],
            rollingUsage: [],
            assessedAt: now,
            expiresAt: new Date("2026-10-03T12:05:00.000Z"),
            traceId: `it-risk-${randomUUID()}`,
          },
        });

        await expect(
          db.riskReservation.create({
            data: {
              id: `reservation-${randomUUID()}`,
              userId,
              assessmentId: duplicateAssessmentId,
              financialPlanId: plan.id,
              financialPlanHash: plan.planHash,
              policyVersion: policy.policyVersion,
              status: "ACTIVE",
              traceId: `it-risk-${randomUUID()}`,
              expiresAt: new Date("2026-10-03T12:05:00.000Z"),
            },
          }),
        ).rejects.toMatchObject({ code: "P2002" });
      },
      15_000,
    );

    it(
      "counts each reservation once per currency even with multiple same-currency entries",
      async () => {
        const userId = await createUser();
        const firstPlan = await createPlan(
          userId,
          "10000",
          "count-a",
          [
            { currency: "USD", minorUnits: "10000" },
            { currency: "USD", minorUnits: "20000" },
          ],
        );
        const repository = new PrismaRiskRepository(db);
        const now = new Date("2026-10-03T12:00:00.000Z");

        const first = await repository.reserve({
          userId,
          financialPlanId: firstPlan.id,
          policy: countPolicy,
          traceId: `it-risk-${randomUUID()}`,
          now,
        });

        expect(first.assessment.decision).toBe("ALLOW");

        const secondPlan = await createPlan(
          userId,
          "10000",
          "count-b",
        );
        const second = await repository.reserve({
          userId,
          financialPlanId: secondPlan.id,
          policy: countPolicy,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:01:00.000Z"),
        });

        expect(second.assessment.decision).toBe("REVIEW");
        expect(second.assessment.reasonCodes).toContain(
          "ROLLING_COUNT_REVIEW_THRESHOLD",
        );
        expect(second.assessment.reasonCodes).not.toContain(
          "ROLLING_COUNT_BLOCK_THRESHOLD",
        );
        expect(second.assessment.rollingUsage).toMatchObject([
          {
            currency: "USD",
            settledTransactionCount: 0,
            reservedTransactionCount: 1,
            reservedAmountMinorUnits: "30000",
          },
        ]);
      },
      15_000,
    );

    it(
      "keeps partial same-currency amount split while counting the plan once",
      async () => {
        const userId = await createUser();
        const firstPlan = await createPlan(
          userId,
          "10000",
          "partial-a",
          [
            { currency: "USD", minorUnits: "10000" },
            { currency: "USD", minorUnits: "20000" },
          ],
        );
        const repository = new PrismaRiskRepository(db);
        const now = new Date("2026-10-03T12:00:00.000Z");
        const first = await repository.reserve({
          userId,
          financialPlanId: firstPlan.id,
          policy: countPolicy,
          traceId: `it-risk-${randomUUID()}`,
          now,
        });

        await repository.validateStepForExecution({
          userId,
          financialPlanId: firstPlan.id,
          financialPlanHash: firstPlan.planHash,
          policy: countPolicy,
          stepId: firstPlan.steps[0]!.id,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:00:30.000Z"),
        });
        await repository.settleStepForPlan({
          userId,
          financialPlanId: firstPlan.id,
          financialPlanHash: firstPlan.planHash,
          policyVersion: countPolicy.policyVersion,
          stepId: firstPlan.steps[0]!.id,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:00:45.000Z"),
        });
        const secondStepValidation =
          await repository.validateStepForExecution({
            userId,
            financialPlanId: firstPlan.id,
            financialPlanHash: firstPlan.planHash,
            policy: countPolicy,
            stepId: firstPlan.steps[1]!.id,
            traceId: `it-risk-${randomUUID()}`,
            now: new Date("2026-10-03T12:00:50.000Z"),
          });
        expect(secondStepValidation.status).toBe("EXECUTING");

        const secondPlan = await createPlan(
          userId,
          "10000",
          "partial-b",
        );
        const second = await repository.reserve({
          userId,
          financialPlanId: secondPlan.id,
          policy: countPolicy,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:01:00.000Z"),
        });

        expect(second.assessment.decision).toBe("REVIEW");
        expect(second.assessment.reasonCodes).not.toContain(
          "ROLLING_COUNT_BLOCK_THRESHOLD",
        );
        expect(second.assessment.rollingUsage).toMatchObject([
          {
            currency: "USD",
            settledAmountMinorUnits: "10000",
            reservedAmountMinorUnits: "20000",
            settledTransactionCount: 0,
            reservedTransactionCount: 1,
          },
        ]);

        const releaseTraceId = `it-risk-${randomUUID()}`;
        await repository.release({
          reservationId: first.reservation!.id,
          userId,
          financialPlanId: firstPlan.id,
          financialPlanHash: firstPlan.planHash,
          policyVersion: countPolicy.policyVersion,
          traceId: releaseTraceId,
          now: new Date("2026-10-03T12:02:00.000Z"),
        });

        const finalized = await db.riskReservation.findUniqueOrThrow({
          where: { id: first.reservation!.id },
          include: { entries: true },
        });
        expect(finalized.status).toBe("CONSUMED");
        expect(finalized.entries.map((entry) => entry.status).sort()).toEqual([
          "RELEASED",
          "SETTLED",
        ]);
        expect(
          await db.auditEvent.count({
            where: {
              aggregateId: first.reservation!.id,
              traceId: releaseTraceId,
              eventType: {
                in: [
                  "RISK_RESERVATION_RELEASED",
                  "RISK_RESERVATION_CONSUMED",
                ],
              },
            },
          }),
        ).toBe(2);
      },
      15_000,
    );

    it(
      "revalidates KYC immediately before execution",
      async () => {
        const userId = await createUser();

        const plan = await createPlan(
          userId,
          "10000",
          "2",
        );

        const repository =
          new PrismaRiskRepository(db);

        const approvalTime = new Date(
          "2026-10-03T12:00:00.000Z",
        );

        const reserved = await repository.reserve({
          userId,
          financialPlanId: plan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now: approvalTime,
        });

        expect(reserved.assessment.decision).toBe("ALLOW");

        await db.userRiskProfile.update({
          where: { userId },
          data: {
            kycStatus: "BLOCKED",
            version: { increment: 1 },
          },
        });

        await expect(
          repository.validateStepForExecution({
            userId,
            financialPlanId: plan.id,
            financialPlanHash: plan.planHash,
            policy,
            stepId: plan.steps[0]!.id,
            traceId: `it-risk-${randomUUID()}`,
            now: new Date(
              "2026-10-03T12:01:00.000Z",
            ),
          }),
        ).rejects.toThrow("RISK_KYC_BLOCKED");
      },
      15_000,
    );

    it(
      "claims an active reservation as non-expiring execution before a bank write",
      async () => {
        const userId = await createUser();

        const plan = await createPlan(
          userId,
          "10000",
          "3",
        );

        const repository =
          new PrismaRiskRepository(db);

        const approvalTime = new Date(
          "2026-10-03T12:00:00.000Z",
        );

        const reserved = await repository.reserve({
          userId,
          financialPlanId: plan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now: approvalTime,
        });

        const executionTime = new Date(
          "2026-10-03T12:01:00.000Z",
        );

        const claimTraceId = `it-risk-${randomUUID()}`;
        const validated =
          await repository.validateStepForExecution({
            userId,
            financialPlanId: plan.id,
            financialPlanHash: plan.planHash,
            policy,
            stepId: plan.steps[0]!.id,
            traceId: claimTraceId,
            now: executionTime,
          });

        expect(validated.status).toBe("EXECUTING");
        expect(validated.expiresAt).toBe(
          reserved.reservation!.expiresAt,
        );
        await repository.validateStepForExecution({
          userId,
          financialPlanId: plan.id,
          financialPlanHash: plan.planHash,
          policy,
          stepId: plan.steps[0]!.id,
          traceId: `it-risk-${randomUUID()}`,
          now: executionTime,
        });
        expect(
          await db.auditEvent.count({
            where: {
              eventType: "RISK_RESERVATION_EXECUTION_CLAIMED",
              aggregateId: reserved.reservation!.id,
            },
          }),
        ).toBe(1);
      },
      15_000,
    );

    it(
      "never expires an executing reservation and keeps it in later velocity",
      async () => {
        const userId = await createUser();
        const planA = await createPlan(userId, "300000", "executing-a");
        const repository = new PrismaRiskRepository(db);
        const reserved = await repository.reserve({
          userId,
          financialPlanId: planA.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:00:00.000Z"),
        });

        await repository.validateStepForExecution({
          userId,
          financialPlanId: planA.id,
          financialPlanHash: planA.planHash,
          policy,
          stepId: planA.steps[0]!.id,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:01:00.000Z"),
        });
        await db.riskReservation.update({
          where: { id: reserved.reservation!.id },
          data: { expiresAt: new Date("2026-10-03T12:02:00.000Z") },
        });

        const planB = await createPlan(userId, "300000", "executing-b");
        const later = await repository.reserve({
          userId,
          financialPlanId: planB.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-04T12:00:00.000Z"),
        });

        expect(later.assessment.decision).toBe("BLOCK");
        expect(later.assessment.reasonCodes).toContain(
          "ROLLING_AMOUNT_BLOCK_THRESHOLD",
        );
        expect(
          await db.riskReservation.findUniqueOrThrow({
            where: { id: reserved.reservation!.id },
          }),
        ).toMatchObject({ status: "EXECUTING" });
      },
      15_000,
    );

    it(
      "fails exact execution binding for bank-state or exposure drift",
      async () => {
        const repository = new PrismaRiskRepository(db);

        const stateUser = await createUser();
        const statePlan = await createPlan(stateUser, "10000", "state-drift");
        const stateReservation = await repository.reserve({
          userId: stateUser,
          financialPlanId: statePlan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:00:00.000Z"),
        });
        await db.riskAssessment.update({
          where: { id: stateReservation.assessment.id },
          data: { bankStateVersion: { increment: 1 } },
        });
        await expect(
          repository.validateStepForExecution({
            userId: stateUser,
            financialPlanId: statePlan.id,
            financialPlanHash: statePlan.planHash,
            policy,
            stepId: statePlan.steps[0]!.id,
            traceId: `it-risk-${randomUUID()}`,
            now: new Date("2026-10-03T12:01:00.000Z"),
          }),
        ).rejects.toThrow("RISK_RESERVATION_BINDING_INVALID");

        const exposureUser = await createUser();
        const exposurePlan = await createPlan(
          exposureUser,
          "10000",
          "exposure-drift",
        );
        const exposureReservation = await repository.reserve({
          userId: exposureUser,
          financialPlanId: exposurePlan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:00:00.000Z"),
        });
        await db.riskVelocityEntry.updateMany({
          where: { reservationId: exposureReservation.reservation!.id },
          data: { minorUnits: 9999n },
        });
        await expect(
          repository.validateStepForExecution({
            userId: exposureUser,
            financialPlanId: exposurePlan.id,
            financialPlanHash: exposurePlan.planHash,
            policy,
            stepId: exposurePlan.steps[0]!.id,
            traceId: `it-risk-${randomUUID()}`,
            now: new Date("2026-10-03T12:01:00.000Z"),
          }),
        ).rejects.toThrow("RISK_RESERVATION_BINDING_INVALID");
      },
      15_000,
    );

    it(
      "rejects execution when the active risk policy version changes",
      async () => {
        const userId = await createUser();

        const plan = await createPlan(
          userId,
          "10000",
          "4",
        );

        const repository =
          new PrismaRiskRepository(db);

        const now = new Date(
          "2026-10-03T12:00:00.000Z",
        );

        await repository.reserve({
          userId,
          financialPlanId: plan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now,
        });

        const changedPolicy = RiskPolicyV1.parse({
          ...policy,
          policyVersion: "it-risk-v2",
        });

        await expect(
          repository.validateStepForExecution({
            userId,
            financialPlanId: plan.id,
            financialPlanHash: plan.planHash,
            policy: changedPolicy,
            stepId: plan.steps[0]!.id,
            traceId: `it-risk-${randomUUID()}`,
            now: new Date(
              "2026-10-03T12:01:00.000Z",
            ),
          }),
        ).rejects.toThrow("RISK_POLICY_CHANGED");
      },
      15_000,
    );

    it(
      "settles an executed step and consumes the completed reservation",
      async () => {
        const userId = await createUser();

        const plan = await createPlan(
          userId,
          "10000",
          "e",
        );

        const repository =
          new PrismaRiskRepository(db);

        const now = new Date(
          "2026-10-03T12:00:00.000Z",
        );

        const reserved = await repository.reserve({
          userId,
          financialPlanId: plan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now,
        });

        expect(reserved.reservation).toBeDefined();

        await repository.validateStepForExecution({
          userId,
          financialPlanId: plan.id,
          financialPlanHash: plan.planHash,
          policy,
          stepId: plan.steps[0]!.id,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:00:30.000Z"),
        });

        const settled = await repository.settleStep({
          reservationId: reserved.reservation!.id,
          userId,
          financialPlanId: plan.id,
          financialPlanHash: plan.planHash,
          policyVersion: policy.policyVersion,
          stepId: plan.steps[0]!.id,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date(
            "2026-10-03T12:01:00.000Z",
          ),
        });

        expect(settled.status).toBe("CONSUMED");

        const entry =
          await db.riskVelocityEntry.findFirstOrThrow({
            where: {
              reservationId: reserved.reservation!.id,
            },
          });

        expect(entry.status).toBe("SETTLED");
        expect(entry.settledAt).not.toBeNull();
      },
      15_000,
    );

    it(
      "settles the same confirmed financial effect idempotently during reconciliation",
      async () => {
        const userId = await createUser();

        const plan = await createPlan(
          userId,
          "10000",
          "5",
        );

        const repository =
          new PrismaRiskRepository(db);

        const now = new Date(
          "2026-10-03T12:00:00.000Z",
        );

        await repository.reserve({
          userId,
          financialPlanId: plan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now,
        });

        await repository.validateStepForExecution({
          userId,
          financialPlanId: plan.id,
          financialPlanHash: plan.planHash,
          policy,
          stepId: plan.steps[0]!.id,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:00:30.000Z"),
        });

        const [first, second] = await Promise.all([
          repository.settleStepForPlan({
            userId,
            financialPlanId: plan.id,
            financialPlanHash: plan.planHash,
            policyVersion: policy.policyVersion,
            stepId: plan.steps[0]!.id,
            traceId: `it-risk-${randomUUID()}`,
            now: new Date(
              "2026-10-03T12:01:00.000Z",
            ),
          }),
          repository.settleStepForPlan({
            userId,
            financialPlanId: plan.id,
            financialPlanHash: plan.planHash,
            policyVersion: policy.policyVersion,
            stepId: plan.steps[0]!.id,
            traceId: `it-risk-${randomUUID()}`,
            now: new Date(
              "2026-10-03T12:02:00.000Z",
            ),
          }),
        ]);

        expect(first.status).toBe("CONSUMED");
        expect(second.status).toBe("CONSUMED");

        expect(
          await db.riskVelocityEntry.count({
            where: {
              reservation: { userId },
              stepId: plan.steps[0]!.id,
              status: "SETTLED",
            },
          }),
        ).toBe(1);
        expect(
          await db.auditEvent.count({
            where: {
              aggregateId: first.id,
              eventType: "RISK_EXPOSURE_SETTLED",
            },
          }),
        ).toBe(1);
      },
      15_000,
    );

    it(
      "releases unused reserved exposure so it does not count against later velocity",
      async () => {
        const userId = await createUser();

        const firstPlan = await createPlan(
          userId,
          "300000",
          "f",
        );

        const repository =
          new PrismaRiskRepository(db);

        const now = new Date(
          "2026-10-03T12:00:00.000Z",
        );

        const first = await repository.reserve({
          userId,
          financialPlanId: firstPlan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now,
        });

        expect(first.assessment.decision).toBe("ALLOW");

        const releaseTraceId = `it-risk-${randomUUID()}`;
        await repository.release({
          reservationId: first.reservation!.id,
          userId,
          financialPlanId: firstPlan.id,
          financialPlanHash: firstPlan.planHash,
          policyVersion: policy.policyVersion,
          traceId: releaseTraceId,
          now: new Date(
            "2026-10-03T12:01:00.000Z",
          ),
        });

        const releasedEntry =
          await db.riskVelocityEntry.findFirstOrThrow({
            where: {
              reservationId: first.reservation!.id,
            },
          });

        expect(releasedEntry.status).toBe("RELEASED");
        expect(
          await db.auditEvent.count({
            where: {
              eventType: "RISK_RESERVATION_RELEASED",
              aggregateId: first.reservation!.id,
              traceId: releaseTraceId,
            },
          }),
        ).toBe(1);

        const secondPlan = await createPlan(
          userId,
          "300000",
          "1",
        );

        const second = await repository.reserve({
          userId,
          financialPlanId: secondPlan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date(
            "2026-10-03T12:02:00.000Z",
          ),
        });

        expect(second.assessment.decision).toBe("ALLOW");
        expect(second.reservation).toBeDefined();
      },
      15_000,
    );

    it(
      "expires only inactive approval reservations and records the lifecycle event",
      async () => {
        const userId = await createUser();
        const repository = new PrismaRiskRepository(db);
        const firstPlan = await createPlan(userId, "10000", "expiry-a");
        const first = await repository.reserve({
          userId,
          financialPlanId: firstPlan.id,
          policy,
          traceId: `it-risk-${randomUUID()}`,
          now: new Date("2026-10-03T12:00:00.000Z"),
        });
        const secondPlan = await createPlan(userId, "10000", "expiry-b");
        const expiryTraceId = `it-risk-${randomUUID()}`;

        await repository.reserve({
          userId,
          financialPlanId: secondPlan.id,
          policy,
          traceId: expiryTraceId,
          now: new Date("2026-10-03T12:06:00.000Z"),
        });

        const expired = await db.riskReservation.findUniqueOrThrow({
          where: { id: first.reservation!.id },
          include: { entries: true },
        });
        expect(expired.status).toBe("EXPIRED");
        expect(expired.entries).toMatchObject([{ status: "EXPIRED" }]);
        expect(
          await db.auditEvent.count({
            where: {
              eventType: "RISK_RESERVATION_EXPIRED",
              aggregateId: first.reservation!.id,
              traceId: expiryTraceId,
            },
          }),
        ).toBe(1);
      },
      15_000,
    );

    it(
      "fails closed when KYC authority is unavailable",
      async () => {
        const userId = `it-risk-${randomUUID()}`;
        createdUsers.push(userId);

        await db.user.create({
          data: { id: userId },
        });

        const plan = await createPlan(
          userId,
          "10000",
          "d",
        );

        const repository =
          new PrismaRiskRepository(db);

        await expect(
          repository.reserve({
            userId,
            financialPlanId: plan.id,
            policy,
            traceId: `it-risk-${randomUUID()}`,
            now: new Date(
              "2026-10-03T12:00:00.000Z",
            ),
          }),
        ).rejects.toThrow("RISK_PROFILE_UNAVAILABLE");

        expect(
          await db.riskReservation.count({
            where: { userId },
          }),
        ).toBe(0);
      },
      15_000,
    );
  },
);
