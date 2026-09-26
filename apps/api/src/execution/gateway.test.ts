import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalV1, FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { expect, it } from "vitest";
import { ExecutionGateway, verifyExecutionApproval, verifyExecutionAuthorization } from "./gateway.js";
import type { StoredApprovalEvidence } from "../webauthn/types.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));
const evidence = (goal: GoalContractV1, plan: FinancialPlanV1, approval: ApprovalV1, overrides: Partial<StoredApprovalEvidence> = {}): StoredApprovalEvidence => ({
  id: approval.signatureReference, approvalId: approval.id, userId: approval.userId, financialPlanId: plan.id,
  goalContractKey: goal.id, goalContractVersion: goal.version, goalContractHash: goal.contractHash, financialPlanHash: plan.planHash,
  bankStateVersion: approval.bankStateVersion, webAuthnCredentialId: "credential-row", challengeId: "challenge-1",
  approvalPayloadHash: "payload-hash", authenticatorCounterBefore: 0, authenticatorCounterAfter: 1,
  userVerified: true, rpId: "localhost", origin: "http://localhost:3000", verifiedAt: new Date().toISOString(), ...overrides,
});

it("rejects stale state without revalidation", () => { const goal = GoalContractV1.parse(fixture("goal-contract.json")); const plan = FinancialPlanV1.parse(fixture("financial-plan.json")); const approval = ApprovalV1.parse({ ...ApprovalV1.parse(fixture("approval.json")), expiresAt: new Date(Date.now() + 60_000).toISOString() }); expect(() => verifyExecutionAuthorization({
  goal, plan, approval, approvalEvidence: evidence(goal, plan, approval), expectedStateVersion: 7, currentStateVersion: 8, revalidationSucceeded: false,
  executionState: "AUTHORIZED", idempotencyKey: "k", proposedStep: plan.steps[0]!,
})).toThrow(/stale/); });

it("allows static approval verification without treating a state mismatch as revalidated", () => {
  const goal = GoalContractV1.parse(fixture("goal-contract.json")); const plan = FinancialPlanV1.parse(fixture("financial-plan.json")); const approval = { ...ApprovalV1.parse(fixture("approval.json")), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const approvalEvidence = evidence(goal, plan, approval);
  expect(() => verifyExecutionApproval({ goal, plan, approval, approvalEvidence, executionState: "AUTHORIZED" })).not.toThrow();
  expect(() => verifyExecutionAuthorization({ goal, plan, approval, approvalEvidence, executionState: "AUTHORIZED", expectedStateVersion: 7, currentStateVersion: 8, revalidationSucceeded: false, idempotencyKey: "k", proposedStep: plan.steps[0]! })).toThrow("State version is stale");
});

it("rejects an executable action that is not exactly in the approved plan", () => {
  const plan = FinancialPlanV1.parse(fixture("financial-plan.json"));
  const goal = GoalContractV1.parse(fixture("goal-contract.json")); const approval = ApprovalV1.parse({ ...ApprovalV1.parse(fixture("approval.json")), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  expect(() => verifyExecutionAuthorization({
    goal, plan, approval, approvalEvidence: evidence(goal, plan, approval), expectedStateVersion: plan.bankStateVersion, currentStateVersion: plan.bankStateVersion, revalidationSucceeded: false,
    executionState: "AUTHORIZED", idempotencyKey: "k", proposedStep: { ...plan.steps[0]!, id: "injected-step" },
  })).toThrow("UNAPPROVED_EXECUTABLE_ACTION");
});

it.each([
  ["missing", undefined],
  ["binding mismatch", { financialPlanHash: "tampered-plan-hash" }],
])("blocks execution with zero bank writes when cryptographic evidence is %s", async (_label, mutation) => {
  const goal = GoalContractV1.parse(fixture("goal-contract.json")); const plan = FinancialPlanV1.parse(fixture("financial-plan.json"));
  const approval = ApprovalV1.parse({ ...ApprovalV1.parse(fixture("approval.json")), expiresAt: new Date(Date.now() + 60_000).toISOString() }); let writes = 0;
  const gateway = new ExecutionGateway({ getState: async () => { throw new Error("unused"); }, execute: async () => { writes += 1; return { accepted: true, bankReference: "unexpected", stateVersion: 8 }; } });
  const approvalEvidence = mutation === undefined ? undefined : evidence(goal, plan, approval, mutation);
  await expect(gateway.execute({ goal, plan, approval, ...(approvalEvidence ? { approvalEvidence } : {}), executionState: "AUTHORIZED", expectedStateVersion: plan.bankStateVersion, currentStateVersion: plan.bankStateVersion, revalidationSucceeded: false, idempotencyKey: "k", proposedStep: plan.steps[0]! }, "trace")).rejects.toThrow(/CRYPTOGRAPHIC_APPROVAL_EVIDENCE/);
  expect(writes).toBe(0);
});
