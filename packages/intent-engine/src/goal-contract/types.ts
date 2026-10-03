import { EntityBinding, GoalContractV1, type IntentDraftV1 } from "@parlance/contracts";
import { z } from "zod";
import type { EntityGroundingResult } from "../grounding/types.js";

const UnconfirmedEntityBinding = EntityBinding.extend({ confirmed: z.literal(false) });

/**
 * Person B's lifecycle-free handoff to Person A. Person A owns user confirmation, identity,
 * versioning, hashing, status, timestamps, and persistence for the canonical GoalContractV1.
 */
export const GoalContractCandidateV1 = GoalContractV1.pick({
  schemaVersion: true,
  goal: true,
  constraints: true,
  preferences: true,
  entityBindings: true,
}).extend({ entityBindings: z.array(UnconfirmedEntityBinding) }).strict();

export type GoalContractCandidate = z.infer<typeof GoalContractCandidateV1>;

export interface GoalContractBuildInput {
  draft: IntentDraftV1;
  groundingResults: readonly EntityGroundingResult[];
}

export interface GoalContractBuilder {
  build(input: GoalContractBuildInput): GoalContractCandidate;
}

export type GoalContractValidationIssue = {
  path: readonly (string | number)[];
  code: string;
  message: string;
};
