import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { describe, expect, it } from "vitest";
import { buildApprovalPayload } from "./approval-payload.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));

describe("canonical passkey approval payload", () => {
  const goal = GoalContractV1.parse({ ...(fixture("goal-contract.json") as object), contractHash: "1".repeat(64) });
  const plan = FinancialPlanV1.parse({ ...(fixture("financial-plan.json") as object), planHash: "2".repeat(64) });
  const expiry = new Date("2026-09-23T10:10:00.000Z");
  const hash = (input: Parameters<typeof buildApprovalPayload>[0]) => buildApprovalPayload(input).payloadHash;
  const baseline = () => hash({ goal, plan, bankStateVersion: 7, approvalExpiresAt: expiry });

  it("constructs the exact versioned financial binding and canonical JSON", () => {
    const result = buildApprovalPayload({ goal, plan, bankStateVersion: 7, approvalExpiresAt: expiry });
    expect(result.payload).toEqual({
      purpose: "PARLANCE_FINANCIAL_PLAN_APPROVAL", payloadVersion: 1, approvalMethod: "PASSKEY",
      userId: goal.userId, goalContractId: goal.id, goalContractVersion: goal.version,
      goalContractHash: goal.contractHash, financialPlanId: plan.id, financialPlanHash: plan.planHash,
      bankStateVersion: 7, approvalExpiresAt: expiry.toISOString(),
    });
    expect(JSON.parse(result.canonicalPayload)).toEqual(result.payload);
  });

  it("changes the hash when any security binding changes", () => {
    const cases = [
      hash({ goal, plan: { ...plan, planHash: "3".repeat(64) }, bankStateVersion: 7, approvalExpiresAt: expiry }),
      hash({ goal: { ...goal, contractHash: "4".repeat(64) }, plan, bankStateVersion: 7, approvalExpiresAt: expiry }),
      hash({ goal, plan, bankStateVersion: 8, approvalExpiresAt: expiry }),
      hash({ goal: { ...goal, userId: "different-user" }, plan, bankStateVersion: 7, approvalExpiresAt: expiry }),
      hash({ goal, plan, bankStateVersion: 7, approvalExpiresAt: new Date(expiry.getTime() + 1) }),
    ];
    expect(new Set([baseline(), ...cases]).size).toBe(cases.length + 1);
  });
});
