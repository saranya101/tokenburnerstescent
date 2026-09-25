import type { GoalContractV1, GoalStatusV1, IntentDraftV1 } from "@parlance/contracts";
import type { EntityGroundingResult } from "../grounding/types.js";

export interface GoalContractMetadata {
  id: string;
  userId: string;
  version: number;
  sourceIntentDraftId?: string;
  status: GoalStatusV1;
  contractHash: string;
  createdAt: string;
  confirmedAt?: string;
  /** Explicit audit value; successful grounding alone never implies user confirmation. */
  bindingConfirmed: boolean;
}

export interface GoalContractBuildInput {
  draft: IntentDraftV1;
  groundingResults: readonly EntityGroundingResult[];
  metadata: GoalContractMetadata;
}

export interface GoalContractBuilder {
  build(input: GoalContractBuildInput): GoalContractV1;
}

export type GoalContractValidationIssue = {
  path: readonly (string | number)[];
  code: string;
  message: string;
};
