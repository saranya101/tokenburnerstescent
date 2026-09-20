import { z } from "zod";
import { Id, MoneyV1, NonNegativeDecimalString, SchemaVersionV1 } from "./common.js";

export const GoalV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("DELIVER_MONEY"), amount: MoneyV1, recipientReference: Id }).strict(),
  z.object({ type: z.literal("ACQUIRE_ASSET"), assetReference: Id, quantity: NonNegativeDecimalString, maxSpend: MoneyV1.optional() }).strict(),
  z.object({ type: z.literal("PAY_BILL"), obligationReference: Id, amount: MoneyV1.optional() }).strict(),
  z.object({ type: z.literal("MOVE_FUNDS"), amount: MoneyV1, sourceAccountReference: Id.optional(), destinationAccountReference: Id }).strict(),
]);
export type GoalV1 = z.infer<typeof GoalV1>;

export const GoalConstraintV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MAX_TOTAL_COST"), money: MoneyV1 }).strict(),
  z.object({ type: z.literal("MIN_AVAILABLE_BALANCE"), money: MoneyV1, accountReference: Id.optional() }).strict(),
  z.object({ type: z.literal("EXCLUDED_ACCOUNT"), accountReference: Id }).strict(),
  z.object({ type: z.literal("MAX_LOCK_IN_DAYS"), days: z.number().int().nonnegative() }).strict(),
]);
export type GoalConstraintV1 = z.infer<typeof GoalConstraintV1>;

export const PreferenceV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MINIMIZE_TOTAL_COST") }).strict(),
  z.object({ type: z.literal("MINIMIZE_FX") }).strict(),
  z.object({ type: z.literal("FASTEST") }).strict(),
  z.object({ type: z.literal("PREFER_ACCOUNT"), accountReference: Id }).strict(),
]);
export type PreferenceV1 = z.infer<typeof PreferenceV1>;

export const IntentReferenceV1 = z.object({
  reference: Id,
  expectedEntityType: z.enum(["ACCOUNT", "BENEFICIARY", "ASSET", "OBLIGATION"]).optional(),
}).strict();

// Strict and operation-free by design: executable action fields are rejected.
export const IntentDraftV1 = z.object({
  schemaVersion: SchemaVersionV1,
  originalText: z.string().min(1),
  goal: GoalV1,
  constraints: z.array(GoalConstraintV1),
  preferences: z.array(PreferenceV1),
  references: z.array(IntentReferenceV1),
}).strict();
export type IntentDraftV1 = z.infer<typeof IntentDraftV1>;
