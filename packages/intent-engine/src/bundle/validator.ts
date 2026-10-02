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

export interface IntentBundleCoverageValidationInput {
  readonly sourceText: string;
  readonly bundle: unknown;
}

type GoalType = IntentBundleDraft["items"][number]["goal"]["type"];
type MismatchDetail = Omit<IntentValidationMismatch, "code" | "field">;

interface ActionSignal {
  readonly type: GoalType;
  readonly start: number;
  readonly end: number;
}

interface ExpectedDependency {
  readonly beforeIndex: number;
  readonly afterIndex: number;
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
    const signals = actionSignals(input.sourceText);

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
  signals: readonly ActionSignal[],
  add: AddMismatch,
): void {
  const expected = explicitOrderSignals(sourceText, signals);
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
  signals: readonly ActionSignal[],
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

function actionSignals(sourceText: string): readonly ActionSignal[] {
  const pattern = /\b(send(?:ing)?|deliver(?:ing)?|remit(?:ting)?|wire|transfer(?:ring)?|buy(?:ing)?|acquir(?:e|ing)|purchas(?:e|ing)|get(?:ting)?|invest(?:ing)?\s+in|pay(?:ing)?|settl(?:e|ing)|mov(?:e|ing))\b/giu;
  const signals: ActionSignal[] = [];
  for (const match of sourceText.matchAll(pattern)) {
    const verb = match[1]?.toLocaleLowerCase();
    if (verb === undefined || match.index === undefined) continue;
    const type = goalTypeForVerb(verb, sourceText.slice(match.index, match.index + 140));
    signals.push({ type, start: match.index, end: match.index + match[0].length });
  }
  return signals;
}

function goalTypeForVerb(verb: string, followingText: string): GoalType {
  if (/^(?:buy|buying|acquir|purchas|get|getting|invest)/u.test(verb)) return "ACQUIRE_ASSET";
  if (/^(?:pay|sett)/u.test(verb)) return "PAY_BILL";
  if (/^mov/u.test(verb)) return "MOVE_FUNDS";
  if (/^transfer/u.test(verb) && /\bfrom\b[\s\S]{0,80}\bto\b/iu.test(followingText)) return "MOVE_FUNDS";
  return "DELIVER_MONEY";
}

function explicitOrderSignals(sourceText: string, signals: readonly ActionSignal[]): readonly ExpectedDependency[] {
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

function minimumBalanceAppearsAfterLastGoal(sourceText: string, signals: readonly ActionSignal[]): boolean {
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
