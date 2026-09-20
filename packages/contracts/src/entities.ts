import { z } from "zod";
import { Id, NonNegativeDecimalString, SchemaVersionV1 } from "./common.js";

export const EntityBinding = z.object({
  schemaVersion: SchemaVersionV1,
  reference: Id,
  entityType: z.enum(["ACCOUNT", "BENEFICIARY", "ASSET", "OBLIGATION"]),
  entityId: Id,
  resolutionMethod: z.enum(["EXACT", "ALIAS", "SEMANTIC", "USER_CONFIRMED"]),
  confidence: NonNegativeDecimalString.optional(),
  confirmed: z.boolean(),
}).strict();
export type EntityBinding = z.infer<typeof EntityBinding>;
