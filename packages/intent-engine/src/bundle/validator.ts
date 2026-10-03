import { IntentBundleDraftV1, type IntentBundleDraftV1 as IntentBundleDraft } from "@parlance/contracts";
import {
  sourceLockInDays,
  sourceSignalsMinimumBalance,
  sourceSupportsExcludedReference,
  sourceSupportsMaxTotalCost,
  sourceSupportsMinimumBalance,
} from "../validation/evidence.js";
import type {
  IndependentIntentValidationResult,
  IntentValidationMismatch,
  IntentValidationMismatchCode,
} from "../validation/types.js";
import { bundleActionSignals, explicitBundleOrderSignals, type BundleActionSignal } from "./source-semantics.js";

export interface IntentBundleCoverageValidationInput {
  readonly sourceText: string;
  readonly bundle: unknown;
}

type MismatchDetail = Omit<IntentValidationMismatch, "code" | "field">;

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
    const signals = bundleActionSignals(input.sourceText);

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

    validateDependencies(input.sourceText, bundle, signals, add);
    validateGlobalConstraints(input.sourceText, bundle, signals, add);
    return mismatches.length === 0 ? pass() : fail(mismatches);
  }
}

function validateDependencies(
  sourceText: string,
  bundle: IntentBundleDraft,
  signals: readonly BundleActionSignal[],
  add: AddMismatch,
): void {
  const expected = explicitBundleOrderSignals(sourceText, signals);
  const actual = new Set(bundle.explicitDependencies.map(({ beforeItemId, afterItemId }) => `${beforeItemId}\u0000${afterItemId}`));
  const expectedKeys = new Set<string>();
  for (const dependency of expected) {
    const before = bundle.items[dependency.beforeIndex];
    const after = bundle.items[dependency.afterIndex];
    if (before === undefined || after === undefined) continue;
    const key = `${before.itemId}\u0000${after.itemId}`;
    expectedKeys.add(key);
    if (!actual.has(key)) {
      add("MISSING_EXPLICIT_DEPENDENCY", "explicitDependencies", { expected: `${before.itemId}->${after.itemId}` });
    }
  }
  bundle.explicitDependencies.forEach((dependency, index) => {
    const key = `${dependency.beforeItemId}\u0000${dependency.afterItemId}`;
    if (!expectedKeys.has(key)) {
      add("DEPENDENCY_NOT_SUPPORTED_BY_SOURCE", `explicitDependencies[${index}]`, { observed: `${dependency.beforeItemId}->${dependency.afterItemId}` });
    }
  });
}

function validateGlobalConstraints(
  sourceText: string,
  bundle: IntentBundleDraft,
  signals: readonly BundleActionSignal[],
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

function minimumBalanceAppearsAfterLastGoal(sourceText: string, signals: readonly BundleActionSignal[]): boolean {
  const lastSignal = signals.at(-1);
  if (lastSignal === undefined) return false;
  const cue = /\b(?:keep|maintain|leave)\b[\s\S]{0,80}\b(?:at\s+least|minimum)\b/giu;
  return [...sourceText.matchAll(cue)].some((match) => (match.index ?? -1) > lastSignal.start);
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
