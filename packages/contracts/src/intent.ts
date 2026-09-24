import { z } from "zod";
import { Id, MoneyV1, NonNegativeDecimalString, SchemaVersionV1 } from "./common.js";

export const AcquireAssetIntentGoalV1 = z.object({
  type: z.literal("ACQUIRE_ASSET"), assetReference: Id,
  budget: MoneyV1.optional(), quantity: NonNegativeDecimalString.optional(),
}).strict().superRefine((goal, context) => {
  if (goal.budget === undefined && goal.quantity === undefined) context.addIssue({ code: "custom", message: "ACQUIRE_ASSET requires budget, quantity, or both" });
});

export const IntentGoalV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("DELIVER_MONEY"), amount: MoneyV1, recipientReference: Id }).strict(),
  AcquireAssetIntentGoalV1,
  z.object({ type: z.literal("PAY_BILL"), billerReference: Id, amount: MoneyV1.optional() }).strict(),
  z.object({ type: z.literal("MOVE_FUNDS"), amount: MoneyV1, sourceAccountReference: Id.optional(), destinationAccountReference: Id }).strict(),
]);
export type IntentGoalV1 = z.infer<typeof IntentGoalV1>;

export const IntentGoalConstraintV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MAX_TOTAL_COST"), money: MoneyV1 }).strict(),
  z.object({ type: z.literal("MIN_AVAILABLE_BALANCE"), money: MoneyV1, accountReference: Id.optional() }).strict(),
  z.object({ type: z.literal("EXCLUDED_ACCOUNT"), accountReference: Id }).strict(),
  z.object({ type: z.literal("MAX_LOCK_IN_DAYS"), days: z.number().int().nonnegative() }).strict(),
]);
export type IntentGoalConstraintV1 = z.infer<typeof IntentGoalConstraintV1>;

export const IntentPreferenceV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MINIMIZE_TOTAL_COST") }).strict(), z.object({ type: z.literal("MINIMIZE_FX") }).strict(),
  z.object({ type: z.literal("FASTEST") }).strict(), z.object({ type: z.literal("PREFER_ACCOUNT"), accountReference: Id }).strict(),
]);
export type IntentPreferenceV1 = z.infer<typeof IntentPreferenceV1>;

export const IntentReferenceV1 = z.object({
  reference: Id, expectedEntityType: z.enum(["ACCOUNT", "BENEFICIARY", "ASSET", "BILLER", "OBLIGATION"]).optional(),
}).strict();

export const IntentDraftV1 = z.object({
  schemaVersion: SchemaVersionV1, originalText: z.string().min(1), goal: IntentGoalV1,
  constraints: z.array(IntentGoalConstraintV1), preferences: z.array(IntentPreferenceV1), references: z.array(IntentReferenceV1),
}).strict();
export type IntentDraftV1 = z.infer<typeof IntentDraftV1>;
