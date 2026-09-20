import { z } from "zod";
import { Hash, Id, IsoTimestamp, MoneyV1, NonNegativeDecimalString, SchemaVersionV1 } from "./common.js";
import { EntityBinding } from "./entities.js";
import { GoalStatusV1 } from "./state-machine.js";

export const AcquireAssetGoalContractGoalV1 = z.object({
  type: z.literal("ACQUIRE_ASSET"), assetId: Id,
  budget: MoneyV1.optional(), quantity: NonNegativeDecimalString.optional(),
}).strict().superRefine((goal, context) => {
  if (goal.budget === undefined && goal.quantity === undefined) context.addIssue({ code: "custom", message: "ACQUIRE_ASSET requires budget, quantity, or both" });
});

export const GroundedGoalV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("DELIVER_MONEY"), amount: MoneyV1, recipientId: Id }).strict(),
  AcquireAssetGoalContractGoalV1,
  z.object({ type: z.literal("PAY_BILL"), billerId: Id, amount: MoneyV1.optional() }).strict(),
  z.object({ type: z.literal("MOVE_FUNDS"), amount: MoneyV1, sourceAccountId: Id.optional(), destinationAccountId: Id }).strict(),
]);
export type GroundedGoalV1 = z.infer<typeof GroundedGoalV1>;

export const GroundedGoalConstraintV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MAX_TOTAL_COST"), money: MoneyV1 }).strict(),
  z.object({ type: z.literal("MIN_AVAILABLE_BALANCE"), money: MoneyV1, accountId: Id.optional() }).strict(),
  z.object({ type: z.literal("EXCLUDED_ACCOUNT"), accountId: Id }).strict(),
  z.object({ type: z.literal("MAX_LOCK_IN_DAYS"), days: z.number().int().nonnegative() }).strict(),
]);
export type GroundedGoalConstraintV1 = z.infer<typeof GroundedGoalConstraintV1>;

export const GroundedPreferenceV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MINIMIZE_TOTAL_COST") }).strict(), z.object({ type: z.literal("MINIMIZE_FX") }).strict(),
  z.object({ type: z.literal("FASTEST") }).strict(), z.object({ type: z.literal("PREFER_ACCOUNT"), accountId: Id }).strict(),
]);
export type GroundedPreferenceV1 = z.infer<typeof GroundedPreferenceV1>;

export const GoalContractV1 = z.object({
  schemaVersion: SchemaVersionV1, id: Id, userId: Id, version: z.number().int().positive(), sourceIntentDraftId: Id.optional(),
  goal: GroundedGoalV1, constraints: z.array(GroundedGoalConstraintV1), preferences: z.array(GroundedPreferenceV1),
  entityBindings: z.array(EntityBinding), status: GoalStatusV1, contractHash: Hash, createdAt: IsoTimestamp, confirmedAt: IsoTimestamp.optional(),
}).strict();
export type GoalContractV1 = z.infer<typeof GoalContractV1>;
