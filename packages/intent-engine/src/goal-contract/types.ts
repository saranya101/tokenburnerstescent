import { GoalContractV1, type IntentDraftV1 } from "@parlance/contracts";
import type { EntityGroundingResult } from "../grounding/types.js";

export const GoalContractCandidateV1 = GoalContractV1.pick({
  schemaVersion: true, goal: true, constraints: true, preferences: true, entityBindings: true,
});
export type GoalContractCandidate = ReturnType<typeof GoalContractCandidateV1.parse>;

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
