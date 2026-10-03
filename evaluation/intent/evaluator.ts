import type { IntentDraftV1 } from "../../packages/contracts/src/index.js";
import type {
  ConstraintRequirement,
  IntentEvaluationAssertionResult,
  IntentEvaluationCase,
  IntentEvaluationResult,
  IntentGoalField,
  MoneyExpectation,
  ReferenceRequirement,
} from "./types.js";

export function evaluateIntentDraft(evaluationCase: IntentEvaluationCase, draft: IntentDraftV1): IntentEvaluationResult {
  const assertions: IntentEvaluationAssertionResult[] = [];
  const assert = (name: string, passed: boolean, failureReason: string): void => {
    assertions.push({ assertion: name, status: passed ? "PASS" : "FAIL", ...(passed ? {} : { failureReason }) });
  };

  const expected = evaluationCase.expected;
  if (expected.goalType !== undefined) {
    assert("expected.goalType", draft.goal.type === expected.goalType, `Expected goal type ${expected.goalType}; received ${draft.goal.type}.`);
  }
  for (const requirement of expected.goalFields ?? []) {
    const actual = goalField(draft, requirement.field);
    assert(`expected.goalFields.${requirement.field}`, actual === requirement.value, `Expected ${requirement.field}=${JSON.stringify(requirement.value)}; received ${JSON.stringify(actual)}.`);
  }
  if (expected.goalMoney !== undefined) {
    const actual = goalField(draft, expected.goalMoney.field);
    assert(
      `expected.goalMoney.${expected.goalMoney.field}`,
      moneyMatches(actual, expected.goalMoney),
      `Expected ${expected.goalMoney.field}=${formatMoney(expected.goalMoney)}; received ${formatUnknownMoney(actual)}.`,
    );
  }
  for (const [index, requirement] of (expected.requiredConstraints ?? []).entries()) {
    const present = draft.constraints.some((constraint) => constraintMatches(constraint, requirement));
    assert(`expected.requiredConstraints.${index}.${requirement.type}`, present, `Missing required ${describeConstraint(requirement)}.`);
  }
  for (const type of expected.requiredPreferenceTypes ?? []) {
    const present = draft.preferences.some((preference) => preference.type === type);
    assert(`expected.requiredPreferenceTypes.${type}`, present, `Missing required preference ${type}.`);
  }
  for (const [index, requirement] of (expected.requiredReferences ?? []).entries()) {
    const present = draft.references.some((reference) => referenceMatches(reference, requirement));
    assert(`expected.requiredReferences.${index}`, present, `Missing required reference ${describeReference(requirement)}.`);
  }
  if (expected.exactOriginalText === true) {
    assert("expected.exactOriginalText", draft.originalText === evaluationCase.inputText, "originalText does not exactly match inputText.");
  }

  const forbidden = evaluationCase.forbidden;
  for (const type of forbidden?.goalTypes ?? []) {
    assert(`forbidden.goalTypes.${type}`, draft.goal.type !== type, `Forbidden goal type ${type} was produced.`);
  }
  for (const type of forbidden?.constraintTypes ?? []) {
    const absent = draft.constraints.every((constraint) => constraint.type !== type);
    assert(`forbidden.constraintTypes.${type}`, absent, `Forbidden constraint type ${type} was produced.`);
  }
  for (const type of forbidden?.preferenceTypes ?? []) {
    const absent = draft.preferences.every((preference) => preference.type !== type);
    assert(`forbidden.preferenceTypes.${type}`, absent, `Forbidden preference type ${type} was produced.`);
  }
  for (const field of forbidden?.goalFields ?? []) {
    const absent = !(field in draft.goal);
    assert(`forbidden.goalFields.${field}`, absent, `Forbidden goal field ${field} was produced.`);
  }
  for (const reference of forbidden?.references ?? []) {
    const absent = draft.references.every((candidate) => candidate.reference !== reference);
    assert(`forbidden.references.${reference}`, absent, `Forbidden reference ${JSON.stringify(reference)} was produced.`);
  }

  const failureReasons = assertions.flatMap((result) => result.failureReason === undefined ? [] : [result.failureReason]);
  return { caseId: evaluationCase.id, status: failureReasons.length === 0 ? "PASS" : "FAIL", assertions, failureReasons };
}

function goalField(draft: IntentDraftV1, field: IntentGoalField): unknown {
  return (draft.goal as unknown as Record<string, unknown>)[field];
}

function moneyMatches(actual: unknown, expected: MoneyExpectation): boolean {
  return isRecord(actual) && actual.currency === expected.currency && actual.minorUnits === expected.minorUnits;
}

function constraintMatches(actual: IntentDraftV1["constraints"][number], expected: ConstraintRequirement): boolean {
  if (actual.type !== expected.type) return false;
  switch (expected.type) {
    case "MAX_TOTAL_COST":
      return actual.type === "MAX_TOTAL_COST" && moneyMatches(actual.money, expected.money);
    case "MIN_AVAILABLE_BALANCE":
      return actual.type === "MIN_AVAILABLE_BALANCE"
        && moneyMatches(actual.money, expected.money)
        && (expected.accountReference === undefined || actual.accountReference === expected.accountReference);
    case "EXCLUDED_ACCOUNT":
      return actual.type === "EXCLUDED_ACCOUNT" && actual.accountReference === expected.accountReference;
    case "MAX_LOCK_IN_DAYS":
      return actual.type === "MAX_LOCK_IN_DAYS" && actual.days === expected.days;
  }
}

function referenceMatches(actual: IntentDraftV1["references"][number], expected: ReferenceRequirement): boolean {
  return actual.reference === expected.reference
    && (expected.expectedEntityType === undefined || actual.expectedEntityType === expected.expectedEntityType);
}

function describeConstraint(requirement: ConstraintRequirement): string {
  switch (requirement.type) {
    case "MAX_TOTAL_COST": return `MAX_TOTAL_COST ${formatMoney(requirement.money)}`;
    case "MIN_AVAILABLE_BALANCE": return `MIN_AVAILABLE_BALANCE ${formatMoney(requirement.money)}${requirement.accountReference === undefined ? "" : ` for ${JSON.stringify(requirement.accountReference)}`}`;
    case "EXCLUDED_ACCOUNT": return `EXCLUDED_ACCOUNT for ${JSON.stringify(requirement.accountReference)}`;
    case "MAX_LOCK_IN_DAYS": return `MAX_LOCK_IN_DAYS=${requirement.days}`;
  }
}

function describeReference(requirement: ReferenceRequirement): string {
  return `${JSON.stringify(requirement.reference)}${requirement.expectedEntityType === undefined ? "" : ` (${requirement.expectedEntityType})`}`;
}

function formatMoney(money: MoneyExpectation): string {
  return `${money.currency} ${money.minorUnits}`;
}

function formatUnknownMoney(value: unknown): string {
  return isRecord(value) && typeof value.currency === "string" && typeof value.minorUnits === "string"
    ? `${value.currency} ${value.minorUnits}`
    : "missing or non-money value";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
