import type { GoalContractValidationIssue } from "./types.js";

export type GoalContractBuilderErrorCode =
  | "UNRESOLVED_REFERENCE"
  | "MISSING_GROUNDING"
  | "TYPE_MISMATCH"
  | "INCONSISTENT_BINDING"
  | "INVALID_GOAL_CONTRACT";

export class GoalContractBuilderError extends Error {
  readonly name = "GoalContractBuilderError";
  constructor(
    readonly code: GoalContractBuilderErrorCode,
    message: string,
    readonly details?: readonly { field?: string; reference?: string; expectedEntityType?: string; entityIds?: readonly string[] }[],
    readonly validationIssues?: readonly GoalContractValidationIssue[],
  ) { super(message); }
}
