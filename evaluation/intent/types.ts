import type { IntentDraftV1 } from "../../packages/contracts/src/index.js";

export type IntentEvaluationCategory = "HAPPY_PATH" | "CONSTRAINT_PRESERVATION" | "ENTITY_ROLE_SEMANTICS" | "REGRESSION";
export type IntentGoalType = IntentDraftV1["goal"]["type"];
export type IntentConstraintType = IntentDraftV1["constraints"][number]["type"];
export type IntentPreferenceType = IntentDraftV1["preferences"][number]["type"];
export type IntentEntityType = NonNullable<IntentDraftV1["references"][number]["expectedEntityType"]>;
export type IntentGoalField = "amount" | "recipientReference" | "assetReference" | "budget" | "quantity" | "billerReference" | "sourceAccountReference" | "destinationAccountReference";
export type IntentGoalScalarField = Exclude<IntentGoalField, "amount" | "budget">;

export interface MoneyExpectation {
  readonly currency: string;
  readonly minorUnits: string;
}

export interface GoalFieldRequirement {
  readonly field: IntentGoalScalarField;
  readonly value: string;
}

export interface GoalMoneyRequirement extends MoneyExpectation {
  readonly field: "amount" | "budget";
}

export type ConstraintRequirement =
  | { readonly type: "MAX_TOTAL_COST"; readonly money: MoneyExpectation }
  | { readonly type: "MIN_AVAILABLE_BALANCE"; readonly money: MoneyExpectation; readonly accountReference?: string }
  | { readonly type: "EXCLUDED_ACCOUNT"; readonly accountReference: string }
  | { readonly type: "MAX_LOCK_IN_DAYS"; readonly days: number };

export interface ReferenceRequirement {
  readonly reference: string;
  readonly expectedEntityType?: IntentEntityType;
}

export interface IntentSemanticRequirements {
  readonly goalType?: IntentGoalType;
  readonly goalFields?: readonly GoalFieldRequirement[];
  readonly goalMoney?: GoalMoneyRequirement;
  readonly requiredConstraints?: readonly ConstraintRequirement[];
  readonly requiredPreferenceTypes?: readonly IntentPreferenceType[];
  readonly requiredReferences?: readonly ReferenceRequirement[];
  /** Requires the validated draft to retain inputText byte-for-byte. */
  readonly exactOriginalText?: boolean;
}

export interface ForbiddenIntentOutcomes {
  readonly goalTypes?: readonly IntentGoalType[];
  readonly constraintTypes?: readonly IntentConstraintType[];
  readonly preferenceTypes?: readonly IntentPreferenceType[];
  readonly goalFields?: readonly IntentGoalField[];
  readonly references?: readonly string[];
}

export interface IntentEvaluationCase {
  readonly id: string;
  readonly category: IntentEvaluationCategory;
  readonly description: string;
  readonly inputText: string;
  readonly expected: IntentSemanticRequirements;
  readonly forbidden?: ForbiddenIntentOutcomes;
}

export interface IntentEvaluationAssertionResult {
  readonly assertion: string;
  readonly status: "PASS" | "FAIL";
  readonly failureReason?: string;
}

export interface IntentEvaluationResult {
  readonly caseId: string;
  readonly status: "PASS" | "FAIL";
  readonly assertions: readonly IntentEvaluationAssertionResult[];
  readonly failureReasons: readonly string[];
}
