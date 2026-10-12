import { IntentBundleDraftV1, type IntentBundleDraftV1 as IntentBundleDraft, type MoneyV1 } from "@parlance/contracts";
import {
  sourceActionClause,
  sourceActionSignals,
  sourceContainsReference,
  sourceLockInDays,
  sourceSignalsMinimumBalance,
  sourceSupportsExcludedReference,
  sourceSupportsMaxTotalCost,
  sourceSupportsMinimumBalance,
  sourceSupportsMoney,
  sourceSupportsQuantity,
  type SourceActionGoalType,
  type SourceActionSignal,
} from "../validation/evidence.js";
import type {
  IndependentIntentValidationResult,
  IntentValidationMismatch,
  IntentValidationMismatchCode,
} from "../validation/types.js";

export interface IntentBundleCoverageValidationInput {
  readonly sourceText: string;
  readonly bundle: unknown;
}

type MismatchDetail = Omit<IntentValidationMismatch, "code" | "field">;
export type { SourceActionGoalType } from "../validation/evidence.js";

interface ExpectedDependency {
  readonly beforeIndex: number;
  readonly afterIndex: number;
}

export interface SourceSupportedExplicitDependency {
  readonly beforeItemId: string;
  readonly afterItemId: string;
  readonly reason: "USER_EXPLICIT_ORDER";
}

/** Deterministically detects missing/extra goals and unsupported ordering edges before grounding. */
export class DeterministicIntentBundleCoverageValidator {
  validate(input: IntentBundleCoverageValidationInput): IndependentIntentValidationResult {
    const mismatches: IntentValidationMismatch[] = [];
    const add = (code: IntentValidationMismatchCode, field: string, detail: MismatchDetail = {}): void => {
      mismatches.push({ code, field, ...detail });
    };
    const parsed = IntentBundleDraftV1.safeParse(input.bundle);
    if (!parsed.success) return fail([{ code: "INVALID_INTENT_BUNDLE", field: "bundle" }]);
    const bundle = parsed.data;
    const signals = sourceActionSignals(input.sourceText);

    if (signals.length > bundle.items.length) {
      add("MISSING_INTENT", "items", { expected: String(signals.length), observed: String(bundle.items.length) });
    }
    if (signals.length < bundle.items.length) {
      add("EXTRA_INTENT", "items", { expected: String(signals.length), observed: String(bundle.items.length) });
    }
    for (let index = 0; index < Math.min(signals.length, bundle.items.length); index += 1) {
      const signal = signals[index];
      const item = bundle.items[index];
      if (signal !== undefined && item !== undefined && signal.type !== item.goal.type) {
        add("INTENT_TYPE_MISMATCH", `items[${index}].goal.type`, { expected: signal.type, observed: item.goal.type });
      }
    }

    validateItemClauseEvidence(input.sourceText, bundle, signals, add);

    validateDependencies(input.sourceText, bundle, signals, add);
    validateGlobalConstraints(input.sourceText, bundle, signals, add);
    return mismatches.length === 0 ? pass() : fail(mismatches);
  }
}

function validateDependencies(
  sourceText: string,
  bundle: IntentBundleDraft,
  signals: readonly SourceActionSignal[],
  add: AddMismatch,
): void {
  const expected = sourceSupportedExplicitDependencies(sourceText, bundle, signals);
  const actual = new Set(bundle.explicitDependencies.map(({ beforeItemId, afterItemId }) => `${beforeItemId}\u0000${afterItemId}`));
  const expectedKeys = new Set<string>();
  for (const dependency of expected) {
    const key = `${dependency.beforeItemId}\u0000${dependency.afterItemId}`;
    expectedKeys.add(key);
    if (!actual.has(key)) {
      add("MISSING_EXPLICIT_DEPENDENCY", "explicitDependencies", { expected: `${dependency.beforeItemId}->${dependency.afterItemId}` });
    }
  }
  bundle.explicitDependencies.forEach((dependency, index) => {
    const key = `${dependency.beforeItemId}\u0000${dependency.afterItemId}`;
    if (!expectedKeys.has(key)) {
      add("DEPENDENCY_NOT_SUPPORTED_BY_SOURCE", `explicitDependencies[${index}]`, { observed: `${dependency.beforeItemId}->${dependency.afterItemId}` });
    }
  });
}

/** Returns only ordering edges that are explicitly and deterministically supported by source text. */
export function sourceSupportedExplicitDependencies(
  sourceText: string,
  bundle: Pick<IntentBundleDraft, "items">,
  signals: readonly SourceActionSignal[] = sourceActionSignals(sourceText),
): readonly SourceSupportedExplicitDependency[] {
  return explicitOrderSignals(sourceText, signals).flatMap(({ beforeIndex, afterIndex }) => {
    const before = bundle.items[beforeIndex];
    const after = bundle.items[afterIndex];
    return before === undefined || after === undefined ? [] : [{
      beforeItemId: before.itemId,
      afterItemId: after.itemId,
      reason: "USER_EXPLICIT_ORDER" as const,
    }];
  });
}

/** Ordered goal types detected by the same deterministic source scanner used for coverage. */
export function sourceActionGoalTypes(sourceText: string): readonly SourceActionGoalType[] {
  return sourceActionSignals(sourceText).map(({ type }) => type);
}

function validateGlobalConstraints(
  sourceText: string,
  bundle: IntentBundleDraft,
  signals: readonly SourceActionSignal[],
  add: AddMismatch,
): void {
  bundle.globalConstraints.forEach((constraint, index) => {
    const supported = constraint.type === "MAX_TOTAL_COST"
      ? sourceSupportsMaxTotalCost(sourceText, constraint.money)
      : constraint.type === "MIN_AVAILABLE_BALANCE"
        ? sourceSupportsMinimumBalance(sourceText, constraint.money)
        : constraint.type === "EXCLUDED_ACCOUNT"
          ? sourceSupportsExcludedReference(sourceText, constraint.accountReference)
          : sourceLockInDays(sourceText).includes(constraint.days);
    if (!supported) add("GLOBAL_CONSTRAINT_NOT_SUPPORTED_BY_SOURCE", `globalConstraints[${index}]`, { observed: constraint.type });
  });

  if (signals.length > 1 && sourceSignalsMinimumBalance(sourceText) && minimumBalanceAppearsAfterLastGoal(sourceText, signals)) {
    const hasSupportedGlobalMinimum = bundle.globalConstraints.some((constraint) =>
      constraint.type === "MIN_AVAILABLE_BALANCE" && sourceSupportsMinimumBalance(sourceText, constraint.money)
    );
    if (!hasSupportedGlobalMinimum) add("MISSING_GLOBAL_CONSTRAINT", "globalConstraints", { expected: "MIN_AVAILABLE_BALANCE" });
  }
}

function explicitOrderSignals(sourceText: string, signals: readonly SourceActionSignal[]): readonly ExpectedDependency[] {
  const dependencies: ExpectedDependency[] = [];
  const first = signals[0];
  if (first !== undefined && signals[1] !== undefined) {
    const prefix = sourceText.slice(0, first.start);
    if (/\bafter\s*$/iu.test(prefix)) dependencies.push({ beforeIndex: 0, afterIndex: 1 });
    if (/\bbefore\s*$/iu.test(prefix)) dependencies.push({ beforeIndex: 1, afterIndex: 0 });
  }
  for (let index = 0; index + 1 < signals.length; index += 1) {
    const current = signals[index];
    const next = signals[index + 1];
    if (current === undefined || next === undefined) continue;
    const between = sourceText.slice(current.end, next.start);
    if (/\bafter\b/iu.test(between)) {
      dependencies.push({ beforeIndex: index + 1, afterIndex: index });
    } else if (/\b(?:and\s+then|then|before)\b/iu.test(between)) {
      dependencies.push({ beforeIndex: index, afterIndex: index + 1 });
    }
  }
  return dependencies;
}

function minimumBalanceAppearsAfterLastGoal(sourceText: string, signals: readonly SourceActionSignal[]): boolean {
  const lastSignal = signals.at(-1);
  if (lastSignal === undefined) return false;
  const cue = /\b(?:keep|maintain|leave)\b[\s\S]{0,80}\b(?:at\s+least|minimum)\b/giu;
  return [...sourceText.matchAll(cue)].some((match) => (match.index ?? -1) > lastSignal.start);
}

function validateItemClauseEvidence(
  sourceText: string,
  bundle: IntentBundleDraft,
  signals: readonly SourceActionSignal[],
  add: AddMismatch,
): void {
  for (let index = 0; index < Math.min(signals.length, bundle.items.length); index += 1) {
    const item = bundle.items[index];
    const clause = sourceActionClause(sourceText, signals, index);
    if (item === undefined || clause === undefined || item.goal.type !== signals[index]?.type) continue;
    const field = `items[${index}].goal`;
    switch (item.goal.type) {
      case "DELIVER_MONEY":
        validateClauseMoney(clause, `${field}.amount`, item.goal.amount, add);
        validateClauseReference(clause, `${field}.recipientReference`, item.goal.recipientReference, add);
        break;
      case "ACQUIRE_ASSET":
        if (item.goal.budget !== undefined) validateClauseMoney(clause, `${field}.budget`, item.goal.budget, add);
        if (item.goal.quantity !== undefined && !sourceSupportsQuantity(clause, item.goal.quantity)) add("QUANTITY_NOT_SUPPORTED_BY_SOURCE", `${field}.quantity`, { observed: item.goal.quantity });
        validateClauseReference(clause, `${field}.assetReference`, item.goal.assetReference, add);
        break;
      case "PAY_BILL":
        if (item.goal.amount !== undefined) validateClauseMoney(clause, `${field}.amount`, item.goal.amount, add);
        validateClauseReference(clause, `${field}.billerReference`, item.goal.billerReference, add);
        break;
      case "MOVE_FUNDS":
        validateClauseMoney(clause, `${field}.amount`, item.goal.amount, add);
        if (item.goal.sourceAccountReference !== undefined) validateClauseReference(clause, `${field}.sourceAccountReference`, item.goal.sourceAccountReference, add);
        validateClauseReference(clause, `${field}.destinationAccountReference`, item.goal.destinationAccountReference, add);
        break;
    }
  }
}

function validateClauseMoney(clause: string, field: string, money: MoneyV1, add: AddMismatch): void {
  if (!sourceSupportsMoney(clause, money)) add("MONEY_NOT_SUPPORTED_BY_SOURCE", field, { observed: `${money.currency}:${money.minorUnits}` });
}

function validateClauseReference(clause: string, field: string, reference: string, add: AddMismatch): void {
  if (!sourceContainsReference(clause, reference)) add("REFERENCE_NOT_SUPPORTED_BY_SOURCE", field, { observed: reference });
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
