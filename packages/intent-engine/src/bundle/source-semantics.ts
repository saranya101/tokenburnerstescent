import type { IntentBundleDraftV1 } from "@parlance/contracts";

export type BundleGoalType = IntentBundleDraftV1["items"][number]["goal"]["type"];

export interface BundleActionSignal {
  readonly type: BundleGoalType;
  readonly start: number;
  readonly end: number;
}

export interface ExplicitBundleOrderSignal {
  readonly beforeIndex: number;
  readonly afterIndex: number;
}

/** Finds only the existing financial goal verbs supported by IntentBundleDraftV1. */
export function bundleActionSignals(sourceText: string): readonly BundleActionSignal[] {
  const pattern = /\b(send(?:ing)?|deliver(?:ing)?|remit(?:ting)?|wire|transfer(?:ring)?|buy(?:ing)?|acquir(?:e|ing)|purchas(?:e|ing)|get(?:ting)?|invest(?:ing)?\s+in|pay(?:ing)?|settl(?:e|ing)|mov(?:e|ing))\b/giu;
  const signals: BundleActionSignal[] = [];
  for (const match of sourceText.matchAll(pattern)) {
    const verb = match[1]?.toLocaleLowerCase();
    if (verb === undefined || match.index === undefined) continue;
    signals.push({
      type: goalTypeForVerb(verb, sourceText.slice(match.index, match.index + 140)),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return signals;
}

/** Converts only explicit then/after/before language into source-action index edges. */
export function explicitBundleOrderSignals(
  sourceText: string,
  signals: readonly BundleActionSignal[] = bundleActionSignals(sourceText),
): readonly ExplicitBundleOrderSignal[] {
  const dependencies: ExplicitBundleOrderSignal[] = [];
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

function goalTypeForVerb(verb: string, followingText: string): BundleGoalType {
  if (/^(?:buy|buying|acquir|purchas|get|getting|invest)/u.test(verb)) return "ACQUIRE_ASSET";
  if (/^(?:pay|sett)/u.test(verb)) return "PAY_BILL";
  if (/^mov/u.test(verb)) return "MOVE_FUNDS";
  if (/^transfer/u.test(verb) && /\bfrom\b[\s\S]{0,80}\bto\b/iu.test(followingText)) return "MOVE_FUNDS";
  return "DELIVER_MONEY";
}
