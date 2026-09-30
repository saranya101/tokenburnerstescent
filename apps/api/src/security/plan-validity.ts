import type { FinancialPlanV1 } from "@parlance/contracts";

export function financialPlanExpired(plan: FinancialPlanV1, now: Date): boolean {
  const validUntil = plan.validity.validUntil;
  return validUntil !== undefined && now.getTime() >= Date.parse(validUntil);
}

export function requireActiveFinancialPlan(plan: FinancialPlanV1, now: Date): void {
  if (financialPlanExpired(plan, now)) throw new Error("FINANCIAL_PLAN_EXPIRED");
}
