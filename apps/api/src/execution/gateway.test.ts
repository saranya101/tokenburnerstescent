import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalV1, FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { expect, it } from "vitest";
import { verifyExecutionApproval, verifyExecutionAuthorization } from "./gateway.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));

it("rejects stale state without revalidation", () => expect(() => verifyExecutionAuthorization({
  goal: GoalContractV1.parse(fixture("goal-contract.json")), plan: FinancialPlanV1.parse(fixture("financial-plan.json")),
  approval: { ...ApprovalV1.parse(fixture("approval.json")), expiresAt: new Date(Date.now() + 60_000).toISOString() }, expectedStateVersion: 7, currentStateVersion: 8, revalidationSucceeded: false,
  executionState: "AUTHORIZED", idempotencyKey: "k", proposedStep: FinancialPlanV1.parse(fixture("financial-plan.json")).steps[0]!,
})).toThrow(/stale/));

it("allows static approval verification without treating a state mismatch as revalidated", () => {
  const goal = GoalContractV1.parse(fixture("goal-contract.json")); const plan = FinancialPlanV1.parse(fixture("financial-plan.json")); const approval = { ...ApprovalV1.parse(fixture("approval.json")), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  expect(() => verifyExecutionApproval({ goal, plan, approval, executionState: "AUTHORIZED" })).not.toThrow();
  expect(() => verifyExecutionAuthorization({ goal, plan, approval, executionState: "AUTHORIZED", expectedStateVersion: 7, currentStateVersion: 8, revalidationSucceeded: false, idempotencyKey: "k", proposedStep: plan.steps[0]! })).toThrow("State version is stale");
});

it("rejects an executable action that is not exactly in the approved plan", () => {
  const plan = FinancialPlanV1.parse(fixture("financial-plan.json"));
  expect(() => verifyExecutionAuthorization({
    goal: GoalContractV1.parse(fixture("goal-contract.json")), plan,
    approval: { ...ApprovalV1.parse(fixture("approval.json")), expiresAt: new Date(Date.now() + 60_000).toISOString() }, expectedStateVersion: plan.bankStateVersion, currentStateVersion: plan.bankStateVersion, revalidationSucceeded: false,
    executionState: "AUTHORIZED", idempotencyKey: "k", proposedStep: { ...plan.steps[0]!, id: "injected-step" },
  })).toThrow("UNAPPROVED_EXECUTABLE_ACTION");
});
