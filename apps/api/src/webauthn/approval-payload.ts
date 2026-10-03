import type { FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { z } from "zod";
import { canonicalHash, canonicalJson } from "../security/canonical-hash.js";
import type { ApprovalPayload } from "./types.js";

export const ApprovalPayloadV1 = z.object({
  purpose: z.literal("PARLANCE_FINANCIAL_PLAN_APPROVAL"), payloadVersion: z.literal(1), approvalMethod: z.literal("PASSKEY"),
  userId: z.string().min(1), goalContractId: z.string().min(1), goalContractVersion: z.number().int().positive(), goalContractHash: z.string().min(16),
  financialPlanId: z.string().min(1), financialPlanHash: z.string().min(16), bankStateVersion: z.number().int().nonnegative(), approvalExpiresAt: z.iso.datetime(),
}).strict();

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
