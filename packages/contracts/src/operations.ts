import { z } from "zod";
import { CurrencyCode, Id, MoneyV1, NonNegativeDecimalString } from "./common.js";

export const FinancialActionV1 = z.enum(["TRANSFER", "FX_CONVERT", "MOVE_FUNDS", "PAY_BILL", "BUY_ASSET", "SELL_ASSET"]);
export type FinancialActionV1 = z.infer<typeof FinancialActionV1>;

const StepBase = z.object({ id: Id, sequence: z.number().int().nonnegative(), dependsOn: z.array(Id), reversible: z.boolean() });
export const FinancialPlanStepV1 = z.discriminatedUnion("action", [
  StepBase.extend({ action: z.literal("TRANSFER"), parameters: z.object({ sourceAccountId: Id, beneficiaryId: Id, amount: MoneyV1 }).strict() }).strict(),
  StepBase.extend({ action: z.literal("FX_CONVERT"), parameters: z.object({ sourceAccountId: Id, destinationAccountId: Id, sourceMoney: MoneyV1, targetCurrency: CurrencyCode, quoteId: Id }).strict() }).strict(),
  StepBase.extend({ action: z.literal("MOVE_FUNDS"), parameters: z.object({ sourceAccountId: Id, destinationAccountId: Id, amount: MoneyV1 }).strict() }).strict(),
  StepBase.extend({ action: z.literal("PAY_BILL"), parameters: z.object({ sourceAccountId: Id, obligationId: Id, amount: MoneyV1 }).strict() }).strict(),
  StepBase.extend({ action: z.literal("BUY_ASSET"), parameters: z.object({ sourceAccountId: Id, assetId: Id, quantity: NonNegativeDecimalString, maximumSpend: MoneyV1 }).strict() }).strict(),
  StepBase.extend({ action: z.literal("SELL_ASSET"), parameters: z.object({ destinationAccountId: Id, assetId: Id, quantity: NonNegativeDecimalString }).strict() }).strict(),
]);
export type FinancialPlanStepV1 = z.infer<typeof FinancialPlanStepV1>;
