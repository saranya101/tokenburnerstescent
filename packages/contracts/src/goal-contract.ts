import { z } from "zod";
import { Hash, Id, IsoTimestamp, SchemaVersionV1 } from "./common.js";
import { EntityBinding } from "./entities.js";
import { GoalConstraintV1, GoalV1, PreferenceV1 } from "./intent.js";
import { GoalStatusV1 } from "./state-machine.js";

export const GoalContractV1 = z.object({
  schemaVersion: SchemaVersionV1,
  id: Id,
  userId: Id,
  version: z.number().int().positive(),
  sourceIntentDraftId: Id.optional(),
  goal: GoalV1,
  constraints: z.array(GoalConstraintV1),
  preferences: z.array(PreferenceV1),
  entityBindings: z.array(EntityBinding),
  status: GoalStatusV1,
  contractHash: Hash,
  createdAt: IsoTimestamp,
  confirmedAt: IsoTimestamp.optional(),
}).strict();
export type GoalContractV1 = z.infer<typeof GoalContractV1>;
