import { z } from "zod";
import { Id, MoneyV1, NonNegativeDecimalString, SchemaVersionV1 } from "./common.js";

export const ExecutionStepResultV1 = z.object({
  stepId: Id, status: z.enum(["PENDING", "ACCEPTED", "SETTLED", "FAILED", "UNKNOWN"]),
  idempotencyKey: Id, bankReference: Id.optional(), errorCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
}).strict();
export const GoalOutcomeV1 = z.object({ achieved: z.boolean(), summary: z.string().min(1), deliveredMoney: MoneyV1.optional(), acquiredAsset: z.object({ assetId: Id, quantity: NonNegativeDecimalString }).strict().optional() }).strict();
export const ExecutionResultV1 = z.object({
  schemaVersion: SchemaVersionV1, executionId: Id, planId: Id, status: z.enum(["PENDING", "EXECUTING", "COMPLETED", "FAILED", "UNKNOWN"]),
  startedStateVersion: z.number().int().nonnegative(), finalStateVersion: z.number().int().nonnegative().optional(), steps: z.array(ExecutionStepResultV1), goalOutcome: GoalOutcomeV1,
}).strict();
export type ExecutionResultV1 = z.infer<typeof ExecutionResultV1>;
