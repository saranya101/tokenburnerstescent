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
    ): Promise<FinancialPlan> {
      const suffix = randomUUID();
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
            amount: {
              currency: "USD",
              minorUnits: amountMinor,
            },
            recipientId: "ben-test",
          },

          preferences: [],
          contractHash: `goal-hash-${suffix}`,
          confirmedAt: new Date(
            "2026-10-03T00:00:00.000Z",
          ),
        },
      });

      const plan = FinancialPlanV1.parse({
        schemaVersion: "1",
        id: planId,
        goalContractId: goalKey,
        goalContractVersion: 1,
        bankStateVersion: 7,
        compilerVersion: "it-risk",
        policyVersion: "compiler-policy-v1",
        operationLibraryVersion: "it-risk",

        steps: [
          {
            id: `${planId}-step`,
            sequence: 0,
            dependsOn: [],
            reversible: false,
            action: "TRANSFER",
            parameters: {
              sourceAccountId: "acc-usd",
              beneficiaryId: "ben-test",
              amount: {
                currency: "USD",
                minorUnits: amountMinor,
              },
            },
          },
        ],

        validity: {
          requiredQuoteIds: [],
        },

        projectedOutcome: {
          goalSatisfied: true,
          deliveredMoney: {
            currency: "USD",
            minorUnits: amountMinor,
          },
          acquiredAssets: [],
          paidObligationIds: [],
          projectedAvailableBalances: [],
          warnings: [],
        },

        planHash: hashCharacter.repeat(64),
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
    });

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
            now: new Date(
              "2026-10-03T12:01:00.000Z",
            ),
          }),
        ).rejects.toThrow("RISK_KYC_BLOCKED");
      },
      15_000,
    );

    it(
      "extends an active reservation when a bank write is about to begin",
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

        const originalExpiry = new Date(
          reserved.reservation!.expiresAt,
        );

        const executionTime = new Date(
          "2026-10-03T12:01:00.000Z",
        );

        const validated =
          await repository.validateStepForExecution({
            userId,
            financialPlanId: plan.id,
            financialPlanHash: plan.planHash,
            policy,
            stepId: plan.steps[0]!.id,
            now: executionTime,
          });

        const expectedMinimum = new Date(
          executionTime.getTime() +
            policy.rollingWindowSeconds * 1000,
        );

        expect(
          new Date(validated.expiresAt).getTime(),
        ).toBeGreaterThanOrEqual(
          expectedMinimum.getTime(),
        );

        expect(
          new Date(validated.expiresAt).getTime(),
        ).toBeGreaterThan(
          originalExpiry.getTime(),
        );
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

        const settled = await repository.settleStep({
          reservationId: reserved.reservation!.id,
          userId,
          financialPlanId: plan.id,
          financialPlanHash: plan.planHash,
          policyVersion: policy.policyVersion,
          stepId: plan.steps[0]!.id,
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

        await repository.release({
          reservationId: first.reservation!.id,
          userId,
          financialPlanId: firstPlan.id,
          financialPlanHash: firstPlan.planHash,
          policyVersion: policy.policyVersion,
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
