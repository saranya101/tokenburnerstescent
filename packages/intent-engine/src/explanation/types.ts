import type {
  CompilerResultV1,
  ExecutionResultV1,
  FinancialActionV1,
  FinancialPlanV1,
  GoalContractV1,
} from "@parlance/contracts";
import type { GoalContractCandidate } from "../goal-contract/types.js";

export type ExplanationInput =
  | { readonly subject: "GOAL"; readonly goal: GoalContractCandidate | GoalContractV1 }
  | { readonly subject: "PLAN"; readonly plan: FinancialPlanV1; readonly goal?: GoalContractV1 }
  | { readonly subject: "COMPILER_RESULT"; readonly result: CompilerResultV1; readonly goal?: GoalContractV1 }
  | { readonly subject: "EXECUTION_RESULT"; readonly result: ExecutionResultV1 };

export type ExplanationKind =
  | "GOAL_SUMMARY"
  | "PLAN_SUMMARY"
  | "COMPILER_SAT"
  | "COMPILER_UNSAT"
  | "POLICY_BLOCKED"
  | "EXECUTION_RESULT";

export type ExplanationStatementKind =
  | "GOAL"
  | "CONSTRAINT"
  | "PREFERENCE"
  | "PLAN_STATUS"
  | "PLAN_STEP"
  | "PROJECTED_OUTCOME"
  | "REASON"
  | "RELAXATION"
  | "EXECUTION_STATUS"
  | "EXECUTION_STEP"
  | "EXECUTION_OUTCOME";

/** A traceable deterministic sentence. Source indexes refer only to validated input arrays. */
export interface ExplanationStatement {
  readonly kind: ExplanationStatementKind;
  readonly text: string;
  readonly sourceSection: "goal" | "constraints" | "preferences" | "plan" | "plan.steps" | "compiler.reason" | "compiler.relaxations" | "execution" | "execution.steps" | "execution.goalOutcome";
  readonly sourceIndex?: number;
  /** Present only for a statement copied from an actual FinancialPlan step. */
  readonly operation?: FinancialActionV1;
}

export interface DeterministicExplanationV1 {
  readonly schemaVersion: "1";
  readonly kind: ExplanationKind;
  readonly title: string;
  readonly statements: readonly ExplanationStatement[];
}

export interface ExplanationRenderer {
  explain(input: ExplanationInput): DeterministicExplanationV1;
}
