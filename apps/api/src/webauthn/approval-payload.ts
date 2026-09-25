import type { FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { canonicalHash, canonicalJson } from "../security/canonical-hash.js";
import type { ApprovalPayload } from "./types.js";

export function buildApprovalPayload(input: {
  goal: GoalContractV1;
  plan: FinancialPlanV1;
  bankStateVersion: number;
  approvalExpiresAt: Date;
}): { payload: ApprovalPayload; canonicalPayload: string; payloadHash: string } {
  const payload: ApprovalPayload = {
    purpose: "PARLANCE_FINANCIAL_PLAN_APPROVAL",
    payloadVersion: 1,
    approvalMethod: "PASSKEY",
    userId: input.goal.userId,
    goalContractId: input.goal.id,
    goalContractVersion: input.goal.version,
    goalContractHash: input.goal.contractHash,
    financialPlanId: input.plan.id,
    financialPlanHash: input.plan.planHash,
    bankStateVersion: input.bankStateVersion,
    approvalExpiresAt: input.approvalExpiresAt.toISOString(),
  };
  return { payload, canonicalPayload: canonicalJson(payload), payloadHash: canonicalHash(payload) };
}
