CREATE UNIQUE INDEX "RiskReservation_one_live_per_financial_plan_key"
ON "RiskReservation" ("financialPlanId")
WHERE "status" IN ('ACTIVE', 'EXECUTING');
