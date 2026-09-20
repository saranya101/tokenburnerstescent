import { z } from "zod";
import { Hash, Id, IsoTimestamp, MoneyV1, NonNegativeDecimalString, SchemaVersionV1 } from "./common.js";
import { FinancialPlanStepV1 } from "./operations.js";

export const ProjectedOutcomeV1 = z.object({
  goalSatisfied: z.boolean(),
  deliveredMoney: MoneyV1.optional(),
  acquiredAssets: z.array(z.object({ assetId: Id, quantity: NonNegativeDecimalString }).strict()),
  paidObligationIds: z.array(Id),
  projectedAvailableBalances: z.array(z.object({ accountId: Id, money: MoneyV1 }).strict()),
  warnings: z.array(z.string()),
}).strict();

export const FinancialPlanV1 = z.object({
  schemaVersion: SchemaVersionV1, id: Id, goalContractId: Id, goalContractVersion: z.number().int().positive(),
  bankStateVersion: z.number().int().nonnegative(), compilerVersion: z.string().min(1), policyVersion: z.string().min(1), operationLibraryVersion: z.string().min(1),
  steps: z.array(FinancialPlanStepV1),
  validity: z.object({ validUntil: IsoTimestamp.optional(), requiredQuoteIds: z.array(Id) }).strict(),
  projectedOutcome: ProjectedOutcomeV1, planHash: Hash,
}).strict();
export type FinancialPlanV1 = z.infer<typeof FinancialPlanV1>;
