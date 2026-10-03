import { IntentDraftV1, type IntentDraftV1 as IntentDraft, type MoneyV1 } from "@parlance/contracts";
import { GoalContractCandidateV1, type GoalContractCandidate } from "../goal-contract/types.js";
import { normalizeEntityReference } from "../grounding/normalizer.js";
import { groundingRequirementsForIntent } from "../grounding/requirements.js";
import {
  looksLikeCanonicalIdentifier,
  sourceContainsReference,
  sourceLockInDays,
  sourceSignalsExcludedAccount,
  sourceSignalsLockIn,
  sourceSignalsMaxTotalCost,
  sourceSignalsMinimumBalance,
  sourceSignalsPreference,
  sourceSignalsPreferredAccount,
  sourceSupportsExcludedReference,
  sourceSupportsGoalType,
  sourceSupportsMaxTotalCost,
  sourceSupportsMinimumBalance,
  sourceSupportsMoney,
  sourceSupportsPreference,
} from "./evidence.js";
import type {
  IndependentIntentValidationInput,
  IndependentIntentValidationResult,
  IndependentIntentValidator,
  IntentValidationMismatch,
  IntentValidationMismatchCode,
} from "./types.js";

type MismatchDetail = Omit<IntentValidationMismatch, "code" | "field">;
type GroundableEntityType = GoalContractCandidate["entityBindings"][number]["entityType"];

/**
 * Pure, deterministic, read-only validation at the Person B -> Person A boundary.
 * It cannot confirm bindings, create GoalContractV1, approve, plan, persist, or execute.
 */
export class DeterministicReadOnlyIntentValidator implements IndependentIntentValidator {
  validate(input: IndependentIntentValidationInput): IndependentIntentValidationResult {
    const mismatches: IntentValidationMismatch[] = [];
    const add = (code: IntentValidationMismatchCode, field: string, detail: MismatchDetail = {}): void => {
      mismatches.push({ code, field, ...detail });
    };

    if (input.sourceText.trim().length === 0) {
      add("EMPTY_SOURCE_TEXT", "sourceText");
      return fail(mismatches);
    }

    const draftResult = IntentDraftV1.safeParse(input.draft);
    if (!draftResult.success) add("INVALID_INTENT_DRAFT", "draft");
    const candidateResult = GoalContractCandidateV1.safeParse(input.candidate);
    if (!candidateResult.success) add("INVALID_GOAL_CANDIDATE", "candidate");
    if (!draftResult.success || !candidateResult.success) return fail(mismatches);

    const draft = draftResult.data;
    const candidate = candidateResult.data;
    if (draft.originalText !== input.sourceText) {
      add("SOURCE_TEXT_MISMATCH", "draft.originalText");
    }

    validateGoal(input.sourceText, draft, candidate, add);
    validateConstraints(input.sourceText, draft, candidate, add);
    validatePreferences(input.sourceText, draft, candidate, add);
    validateBindings(input.sourceText, draft, candidate, add);
    validateOmissions(input.sourceText, draft, add);

    return mismatches.length === 0 ? pass() : fail(mismatches);
  }
}

function validateGoal(
  sourceText: string,
  draft: IntentDraft,
  candidate: GoalContractCandidate,
  add: AddMismatch,
): void {
  if (candidate.goal.type !== draft.goal.type) {
    add("GOAL_TYPE_MISMATCH", "goal.type", { expected: draft.goal.type, observed: candidate.goal.type });
    return;
  }
  if (!sourceSupportsGoalType(sourceText, draft.goal.type)) {
    add("GOAL_TYPE_NOT_SUPPORTED_BY_SOURCE", "goal.type", { observed: draft.goal.type });
  }

  switch (draft.goal.type) {
    case "DELIVER_MONEY": {
      if (candidate.goal.type !== "DELIVER_MONEY") return;
      validateMoney(sourceText, "goal.amount", draft.goal.amount, candidate.goal.amount, add);
      validateSemanticReference(sourceText, candidate, "goal.recipientReference", draft.goal.recipientReference, "BENEFICIARY", candidate.goal.recipientId, add);
      return;
    }
    case "ACQUIRE_ASSET": {
      if (candidate.goal.type !== "ACQUIRE_ASSET") return;
      if (draft.goal.budget === undefined !== (candidate.goal.budget === undefined)) {
        add("MONEY_MISMATCH", "goal.budget", { expected: describeMoney(draft.goal.budget), observed: describeMoney(candidate.goal.budget) });
      } else if (draft.goal.budget !== undefined && candidate.goal.budget !== undefined) {
        validateMoney(sourceText, "goal.budget", draft.goal.budget, candidate.goal.budget, add);
      }
      if (draft.goal.quantity !== candidate.goal.quantity) {
        add("QUANTITY_MISMATCH", "goal.quantity", { expected: draft.goal.quantity ?? "absent", observed: candidate.goal.quantity ?? "absent" });
      }
      validateSemanticReference(sourceText, candidate, "goal.assetReference", draft.goal.assetReference, "ASSET", candidate.goal.assetId, add);
      return;
    }
    case "PAY_BILL": {
      if (candidate.goal.type !== "PAY_BILL") return;
      if (draft.goal.amount === undefined !== (candidate.goal.amount === undefined)) {
        add("MONEY_MISMATCH", "goal.amount", { expected: describeMoney(draft.goal.amount), observed: describeMoney(candidate.goal.amount) });
      } else if (draft.goal.amount !== undefined && candidate.goal.amount !== undefined) {
        validateMoney(sourceText, "goal.amount", draft.goal.amount, candidate.goal.amount, add);
      }
      validateSemanticReference(sourceText, candidate, "goal.billerReference", draft.goal.billerReference, "BILLER", candidate.goal.billerId, add);
      return;
    }
    case "MOVE_FUNDS": {
      if (candidate.goal.type !== "MOVE_FUNDS") return;
      validateMoney(sourceText, "goal.amount", draft.goal.amount, candidate.goal.amount, add);
      if (draft.goal.sourceAccountReference === undefined !== (candidate.goal.sourceAccountId === undefined)) {
        add("BINDING_MISSING", "goal.sourceAccountReference");
      } else if (draft.goal.sourceAccountReference !== undefined && candidate.goal.sourceAccountId !== undefined) {
        validateSemanticReference(sourceText, candidate, "goal.sourceAccountReference", draft.goal.sourceAccountReference, "ACCOUNT", candidate.goal.sourceAccountId, add);
      }
      validateSemanticReference(sourceText, candidate, "goal.destinationAccountReference", draft.goal.destinationAccountReference, "ACCOUNT", candidate.goal.destinationAccountId, add);
    }
  }
}

function validateConstraints(sourceText: string, draft: IntentDraft, candidate: GoalContractCandidate, add: AddMismatch): void {
  if (draft.constraints.length !== candidate.constraints.length) {
    add("CONSTRAINT_COUNT_MISMATCH", "constraints", { expected: String(draft.constraints.length), observed: String(candidate.constraints.length) });
  }
  for (let index = 0; index < Math.min(draft.constraints.length, candidate.constraints.length); index += 1) {
    const expected = draft.constraints[index];
    const observed = candidate.constraints[index];
    if (expected === undefined || observed === undefined) continue;
    const field = `constraints[${index}]`;
    if (expected.type !== observed.type) {
      add("CONSTRAINT_MISMATCH", `${field}.type`, { expected: expected.type, observed: observed.type });
      continue;
    }
    switch (expected.type) {
      case "MAX_TOTAL_COST":
        if (observed.type !== "MAX_TOTAL_COST") break;
        validateMoney(sourceText, `${field}.money`, expected.money, observed.money, add);
        if (!sourceSupportsMaxTotalCost(sourceText, expected.money)) add("CONSTRAINT_NOT_SUPPORTED_BY_SOURCE", field, { observed: expected.type });
        break;
      case "MIN_AVAILABLE_BALANCE":
        if (observed.type !== "MIN_AVAILABLE_BALANCE") break;
        validateMoney(sourceText, `${field}.money`, expected.money, observed.money, add);
        if (!sourceSupportsMinimumBalance(sourceText, expected.money)) add("CONSTRAINT_NOT_SUPPORTED_BY_SOURCE", field, { observed: expected.type });
        if (expected.accountReference === undefined !== (observed.accountId === undefined)) {
          add("CONSTRAINT_MISMATCH", `${field}.accountReference`);
        } else if (expected.accountReference !== undefined && observed.accountId !== undefined) {
          validateSemanticReference(sourceText, candidate, `${field}.accountReference`, expected.accountReference, "ACCOUNT", observed.accountId, add);
        }
        break;
      case "EXCLUDED_ACCOUNT":
        if (observed.type !== "EXCLUDED_ACCOUNT") break;
        validateSemanticReference(sourceText, candidate, `${field}.accountReference`, expected.accountReference, "ACCOUNT", observed.accountId, add);
        if (!sourceSupportsExcludedReference(sourceText, expected.accountReference)) add("CONSTRAINT_NOT_SUPPORTED_BY_SOURCE", field, { observed: expected.type });
        break;
      case "MAX_LOCK_IN_DAYS":
        if (observed.type !== "MAX_LOCK_IN_DAYS") break;
        if (expected.days !== observed.days) add("CONSTRAINT_MISMATCH", `${field}.days`, { expected: String(expected.days), observed: String(observed.days) });
        if (!sourceLockInDays(sourceText).includes(expected.days)) add("CONSTRAINT_NOT_SUPPORTED_BY_SOURCE", field, { observed: `${expected.days} days` });
        break;
    }
  }
}

function validatePreferences(sourceText: string, draft: IntentDraft, candidate: GoalContractCandidate, add: AddMismatch): void {
  if (draft.preferences.length !== candidate.preferences.length) {
    add("PREFERENCE_COUNT_MISMATCH", "preferences", { expected: String(draft.preferences.length), observed: String(candidate.preferences.length) });
  }
  for (let index = 0; index < Math.min(draft.preferences.length, candidate.preferences.length); index += 1) {
    const expected = draft.preferences[index];
    const observed = candidate.preferences[index];
    if (expected === undefined || observed === undefined) continue;
    const field = `preferences[${index}]`;
    if (expected.type !== observed.type) {
      add("PREFERENCE_MISMATCH", `${field}.type`, { expected: expected.type, observed: observed.type });
      continue;
    }
    if (expected.type === "PREFER_ACCOUNT") {
      if (observed.type !== "PREFER_ACCOUNT") continue;
      validateSemanticReference(sourceText, candidate, `${field}.accountReference`, expected.accountReference, "ACCOUNT", observed.accountId, add);
      if (!sourceSupportsPreference(sourceText, expected.type, expected.accountReference)) add("PREFERENCE_NOT_SUPPORTED_BY_SOURCE", field, { observed: expected.type });
    } else if (!sourceSupportsPreference(sourceText, expected.type)) {
      add("PREFERENCE_NOT_SUPPORTED_BY_SOURCE", field, { observed: expected.type });
    }
  }
}

function validateBindings(sourceText: string, draft: IntentDraft, candidate: GoalContractCandidate, add: AddMismatch): void {
  const requirements = groundingRequirementsForIntent(draft);
  const seen = new Set<string>();
  for (const [index, binding] of candidate.entityBindings.entries()) {
    const field = `candidate.entityBindings[${index}]`;
    validateReferenceEvidence(sourceText, `${field}.reference`, binding.reference, add);
    const key = `${binding.reference}\u0000${binding.entityType}\u0000${binding.entityId}`;
    if (seen.has(key)) add("DUPLICATE_BINDING", field);
    seen.add(key);
    const allowed = requirements.some((requirement) =>
      normalizeEntityReference(requirement.reference) === normalizeEntityReference(binding.reference)
      && (requirement.expectedEntityType === undefined || requirement.expectedEntityType === binding.entityType)
    );
    if (!allowed) add("UNEXPECTED_BINDING", field, { observed: binding.entityType });
  }
}

function validateOmissions(sourceText: string, draft: IntentDraft, add: AddMismatch): void {
  const constraintTypes = new Set(draft.constraints.map(({ type }) => type));
  if (sourceSignalsMaxTotalCost(sourceText) && !constraintTypes.has("MAX_TOTAL_COST")) add("OMITTED_EXPLICIT_CONSTRAINT", "constraints", { expected: "MAX_TOTAL_COST" });
  if (sourceSignalsMinimumBalance(sourceText) && !constraintTypes.has("MIN_AVAILABLE_BALANCE")) add("OMITTED_EXPLICIT_CONSTRAINT", "constraints", { expected: "MIN_AVAILABLE_BALANCE" });
  if (sourceSignalsExcludedAccount(sourceText) && !constraintTypes.has("EXCLUDED_ACCOUNT")) add("OMITTED_EXPLICIT_CONSTRAINT", "constraints", { expected: "EXCLUDED_ACCOUNT" });
  if (sourceSignalsLockIn(sourceText) && !constraintTypes.has("MAX_LOCK_IN_DAYS")) add("OMITTED_EXPLICIT_CONSTRAINT", "constraints", { expected: "MAX_LOCK_IN_DAYS" });

  const preferenceTypes = new Set(draft.preferences.map(({ type }) => type));
  for (const type of ["FASTEST", "MINIMIZE_TOTAL_COST", "MINIMIZE_FX"] as const) {
    if (sourceSignalsPreference(sourceText, type) && !preferenceTypes.has(type)) add("OMITTED_EXPLICIT_PREFERENCE", "preferences", { expected: type });
  }
  if (sourceSignalsPreferredAccount(sourceText) && !preferenceTypes.has("PREFER_ACCOUNT")) add("OMITTED_EXPLICIT_PREFERENCE", "preferences", { expected: "PREFER_ACCOUNT" });
}

function validateMoney(sourceText: string, field: string, expected: MoneyV1, observed: MoneyV1, add: AddMismatch): void {
  if (expected.currency !== observed.currency || expected.minorUnits !== observed.minorUnits) {
    add("MONEY_MISMATCH", field, { expected: describeMoney(expected), observed: describeMoney(observed) });
  }
  if (!sourceSupportsMoney(sourceText, expected)) add("MONEY_NOT_SUPPORTED_BY_SOURCE", field, { observed: describeMoney(expected) });
}

function validateSemanticReference(
  sourceText: string,
  candidate: GoalContractCandidate,
  field: string,
  reference: string,
  entityType: GroundableEntityType,
  entityId: string,
  add: AddMismatch,
): void {
  validateReferenceEvidence(sourceText, field, reference, add);
  const matching = candidate.entityBindings.filter((binding) => binding.reference === reference && binding.entityType === entityType);
  if (matching.length === 0) {
    add("BINDING_MISSING", field, { expected: entityType });
    return;
  }
  const ids = new Set(matching.map((binding) => binding.entityId));
  if (ids.size !== 1 || !ids.has(entityId)) {
    add("BINDING_ENTITY_MISMATCH", field, { expected: entityId, observed: [...ids].sort().join(",") });
  }
}

function validateReferenceEvidence(sourceText: string, field: string, reference: string, add: AddMismatch): void {
  if (!sourceContainsReference(sourceText, reference)) add("REFERENCE_NOT_SUPPORTED_BY_SOURCE", field);
  if (looksLikeCanonicalIdentifier(reference)) add("CANONICAL_IDENTIFIER_REFERENCE", field);
}

function describeMoney(money: MoneyV1 | undefined): string {
  return money === undefined ? "absent" : `${money.currency}:${money.minorUnits}`;
}

type AddMismatch = (code: IntentValidationMismatchCode, field: string, detail?: MismatchDetail) => void;

function pass(): IndependentIntentValidationResult {
  const mismatches = Object.freeze([]) as readonly [];
  return Object.freeze({ status: "PASS" as const, mismatches });
}

function fail(mismatches: readonly IntentValidationMismatch[]): IndependentIntentValidationResult {
  return Object.freeze({
    status: "FAIL" as const,
    mismatches: Object.freeze(mismatches.map((mismatch) => Object.freeze({ ...mismatch }))),
  });
}
