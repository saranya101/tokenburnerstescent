import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FinancialPlanV1 } from "@parlance/contracts";
import { expect, it } from "vitest";
import { financialPlanExpired, requireActiveFinancialPlan } from "./plan-validity.js";

const plan = FinancialPlanV1.parse(JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer/financial-plan.json"), "utf8")));
const expiresAt = new Date(plan.validity.validUntil!);

it("uses server time and treats the exact persisted validUntil instant as expired", () => {
  expect(financialPlanExpired(plan, new Date(expiresAt.getTime() - 1))).toBe(false);
  expect(financialPlanExpired(plan, expiresAt)).toBe(true);
  expect(() => requireActiveFinancialPlan(plan, expiresAt)).toThrow("FINANCIAL_PLAN_EXPIRED");
});

it("does not invent an expiry when the persisted plan has none", () => {
  const withoutExpiry = FinancialPlanV1.parse({ ...plan, validity: { requiredQuoteIds: plan.validity.requiredQuoteIds } });
  expect(financialPlanExpired(withoutExpiry, new Date("2099-01-01T00:00:00.000Z"))).toBe(false);
});
