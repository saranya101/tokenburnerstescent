import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@parlance/db";
import { ApprovalV1 } from "@parlance/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaParlanceRepository } from "../repositories/prisma.js";
import type { StoredApprovalEvidence } from "./types.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const userId = "it-webauthn-user";

describe.skipIf(!testDatabaseUrl)("WebAuthn PostgreSQL challenge authority", () => {
  let db: PrismaClient;
  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: testDatabaseUrl! });
    const runIds = (await db.executionRun.findMany({ where: { userId }, select: { id: true } })).map((row) => row.id); await db.executionStep.deleteMany({ where: { executionRunId: { in: runIds } } }); await db.executionRun.deleteMany({ where: { userId } });
    await db.approvalEvidence.deleteMany({ where: { userId } }); await db.approval.deleteMany({ where: { userId } });
    await db.webAuthnCredential.deleteMany({ where: { userId } });
    await db.webAuthnChallenge.deleteMany({ where: { userId } });
    await db.financialPlanStep.deleteMany({ where: { plan: { goalContract: { userId } } } }); await db.financialPlan.deleteMany({ where: { goalContract: { userId } } });
    const goalIds = (await db.goalContract.findMany({ where: { userId }, select: { id: true } })).map((row) => row.id); await db.goalEntityBinding.deleteMany({ where: { goalContractId: { in: goalIds } } }); await db.goalConstraint.deleteMany({ where: { goalContractId: { in: goalIds } } }); await db.goalContract.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.user.create({ data: { id: userId } });
  });
  afterAll(async () => {
    if (!db) return;
    const runIds = (await db.executionRun.findMany({ where: { userId }, select: { id: true } })).map((row) => row.id); await db.executionStep.deleteMany({ where: { executionRunId: { in: runIds } } }); await db.executionRun.deleteMany({ where: { userId } });
    await db.approvalEvidence.deleteMany({ where: { userId } }); await db.approval.deleteMany({ where: { userId } });
    await db.webAuthnCredential.deleteMany({ where: { userId } });
    await db.webAuthnChallenge.deleteMany({ where: { userId } });
    await db.financialPlanStep.deleteMany({ where: { plan: { goalContract: { userId } } } }); await db.financialPlan.deleteMany({ where: { goalContract: { userId } } });
    const goalIds = (await db.goalContract.findMany({ where: { userId }, select: { id: true } })).map((row) => row.id); await db.goalEntityBinding.deleteMany({ where: { goalContractId: { in: goalIds } } }); await db.goalConstraint.deleteMany({ where: { goalContractId: { in: goalIds } } }); await db.goalContract.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("atomically permits exactly one registration consumer and persists one bound credential", async () => {
    const repository = new PrismaParlanceRepository(db); const now = new Date();
    const challenge = await repository.createWebAuthnChallenge({
      id: randomUUID(), userId, purpose: "REGISTRATION", challenge: randomBytes(32).toString("base64url"),
      userHandle: new Uint8Array(randomBytes(32)), expectedRpId: "localhost", expectedOrigin: "http://localhost:3000",
      expiresAt: new Date(now.getTime() + 180_000),
    });
    const credential = { id: randomUUID(), userId, credentialId: `it-credential-${randomUUID()}`, publicKey: new Uint8Array([1, 2, 3]), userHandle: challenge.userHandle!, signCount: 0, transports: ["internal"], deviceType: "multiDevice", backedUp: true };
    const outcomes = await Promise.all([
      repository.consumeRegistrationChallenge({ challengeId: challenge.id, userId, now, credential }),
      repository.consumeRegistrationChallenge({ challengeId: challenge.id, userId, now, credential: { ...credential, id: randomUUID() } }),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await db.webAuthnCredential.count({ where: { userId } })).toBe(1);
    expect((await repository.getWebAuthnChallenge(challenge.id))?.status).toBe("CONSUMED");
    expect((await repository.getWebAuthnCredential(credential.credentialId))?.userId).toBe(userId);
  });

  it("atomically permits exactly one verified assertion authorization and reconstructs its evidence", async () => {
    const repository = new PrismaParlanceRepository(db); const now = new Date(); const goalRowId = "it-wa-goal-row"; const goalKey = "it-wa-goal"; const planId = "it-wa-plan"; const credentialRowId = "it-wa-credential-row"; const challengeId = "it-wa-approval-challenge";
    await db.goalContract.create({ data: { id: goalRowId, contractKey: goalKey, version: 1, userId, status: "CONFIRMED", schemaVersion: "1", goalPayload: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientId: "ben-test" }, preferences: [], contractHash: "goal-hash-value-0001", confirmedAt: now } });
    await db.financialPlan.create({ data: { id: planId, goalContractRowId: goalRowId, goalContractKey: goalKey, status: "READY", schemaVersion: "1", goalContractVersion: 1, bankStateVersion: 7, compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test", validity: { requiredQuoteIds: [] }, projectedOutcome: { goalSatisfied: true, acquiredAssets: [], paidObligationIds: [], projectedAvailableBalances: [], warnings: [] }, planHash: "plan-hash-value-0001", traceId: "it-wa-trace", steps: { create: { stepKey: "step-1", sequence: 0, action: "TRANSFER", dependsOn: [], reversible: false, parameters: { sourceAccountId: "acc-1", beneficiaryId: "ben-test", amount: { currency: "USD", minorUnits: "100" } } } } } });
    await repository.saveWebAuthnCredential({ id: credentialRowId, userId, credentialId: "it-wa-credential", publicKey: new Uint8Array([1, 2, 3]), userHandle: new Uint8Array([4]), signCount: 0, transports: ["internal"], deviceType: "multiDevice", backedUp: true });
    await repository.createWebAuthnChallenge({ id: challengeId, userId, purpose: "APPROVAL", challenge: "it-wa-challenge-value", expectedRpId: "localhost", expectedOrigin: "http://localhost:3000", financialPlanId: planId, approvalPayloadHash: "payload-hash-value-0001", approvalPayload: { purpose: "PARLANCE_FINANCIAL_PLAN_APPROVAL", payloadVersion: 1, approvalMethod: "PASSKEY", userId, goalContractId: goalKey, goalContractVersion: 1, goalContractHash: "goal-hash-value-0001", financialPlanId: planId, financialPlanHash: "plan-hash-value-0001", bankStateVersion: 7, approvalExpiresAt: new Date(now.getTime() + 60_000).toISOString() }, expiresAt: new Date(now.getTime() + 60_000) });
    const attempt = (suffix: string) => {
      const approval = ApprovalV1.parse({ schemaVersion: "1", id: `it-wa-approval-${suffix}`, userId, goalContractId: goalKey, goalContractVersion: 1, goalContractHash: "goal-hash-value-0001", financialPlanId: planId, financialPlanHash: "plan-hash-value-0001", bankStateVersion: 7, method: "PASSKEY", approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), signatureReference: `it-wa-evidence-${suffix}` });
      const evidence: StoredApprovalEvidence = { id: approval.signatureReference, approvalId: approval.id, userId, financialPlanId: planId, goalContractKey: goalKey, goalContractVersion: 1, goalContractHash: approval.goalContractHash, financialPlanHash: approval.financialPlanHash, bankStateVersion: 7, webAuthnCredentialId: credentialRowId, challengeId, approvalPayloadHash: "payload-hash-value-0001", authenticatorCounterBefore: 0, authenticatorCounterAfter: 1, userVerified: true, rpId: "localhost", origin: "http://localhost:3000", verifiedAt: now.toISOString() };
      return repository.authorizeVerifiedPasskey({ goalRowId, approval, executionId: `it-wa-execution-${suffix}`, evidence, challengeId, credentialId: credentialRowId, expectedCounter: 0, newCounter: 1, now, traceId: "it-wa-trace" });
    };
    const outcomes = await Promise.allSettled([attempt("one"), attempt("two")]); expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await db.approvalEvidence.count({ where: { userId } })).toBe(1); expect(await db.approval.count({ where: { userId } })).toBe(1); expect(await db.executionRun.count({ where: { userId } })).toBe(1);
    expect((await repository.getWebAuthnChallenge(challengeId))?.status).toBe("CONSUMED"); expect((await repository.getWebAuthnCredential("it-wa-credential"))?.signCount).toBe(1);
    const approvalRow = await db.approval.findFirstOrThrow({ where: { userId } }); const restored = await repository.getApproval(approvalRow.id); expect(restored?.evidence).toMatchObject({ id: approvalRow.signatureReference, approvalId: approvalRow.id, userVerified: true, authenticatorCounterBefore: 0, authenticatorCounterAfter: 1 });
  });
});
