import {
  IntentBundleDraftV1,
  IntentBundleItemDraftV1,
  type IntentBundleDraftV1 as IntentBundleDraft,
} from "@parlance/contracts";
import { z } from "zod";
import { IntentInterpreterError } from "../interpreter/errors.js";
import type { IntentValidationIssue, ModelClientDiagnostic, ModelClientDiagnosticError } from "../interpreter/types.js";
import { INTENT_BUNDLE_PROMPT_VERSION, INTENT_BUNDLE_V1_SYSTEM_PROMPT } from "../prompts/intent-bundle-v1.js";
import { sourceMinimumBalanceMoneyAfter } from "../validation/evidence.js";
import type {
  ClarifiedIntentBundleItem,
  IntentBundleInterpreter,
  IntentBundleItemIdFactory,
  IntentBundleModelClient,
  InterpretIntentBundleInput,
} from "./types.js";
import { bundleActionSignals, explicitBundleOrderSignals } from "./source-semantics.js";

const ClarifiedIntentBundleItemV1 = IntentBundleItemDraftV1.omit({ itemId: true }).strict();

/** Parses an untrusted model bundle and assigns stable application-owned item IDs. */
export class ModelBackedIntentBundleInterpreter implements IntentBundleInterpreter {
  constructor(
    private readonly modelClient: IntentBundleModelClient,
    private readonly itemIdFactory: IntentBundleItemIdFactory = (index) => `item-${index + 1}`,
  ) {}

  async interpretUserRequest(input: InterpretIntentBundleInput): Promise<IntentBundleDraft> {
    if (input.text.trim().length === 0) throw new IntentInterpreterError("EMPTY_INPUT", "User input must not be empty.");

    let candidate: unknown;
    try {
      candidate = await this.modelClient.generateIntentBundle({
        text: input.text,
        systemPrompt: INTENT_BUNDLE_V1_SYSTEM_PROMPT,
        promptVersion: INTENT_BUNDLE_PROMPT_VERSION,
      });
    } catch (error) {
      throw new IntentInterpreterError("MODEL_ERROR", "The intent model could not generate an intent bundle.", undefined, modelDiagnostic(error));
    }

    const modelBundle = IntentBundleDraftV1.safeParse(candidate);
    if (!modelBundle.success) {
      throw new IntentInterpreterError(
        "INVALID_MODEL_OUTPUT",
        "The intent model returned an invalid intent bundle.",
        validationIssues(modelBundle.error),
      );
    }
    const sourceAligned = alignBundleToSource(modelBundle.data, input.text);
    const stableBundle = IntentBundleDraftV1.safeParse(assignStableItemIds(sourceAligned, this.itemIdFactory));
    if (!stableBundle.success) {
      throw new IntentInterpreterError(
        "INVALID_MODEL_OUTPUT",
        "The intent model returned an intent bundle that could not be assigned stable item IDs.",
        validationIssues(stableBundle.error),
      );
    }
    return stableBundle.data;
  }
}

/**
 * Replaces only the clarified item's semantic payload. All other items, IDs, global constraints,
 * explicit dependencies, and array positions are preserved byte-for-byte at the value level.
 */
export function replaceClarifiedIntentBundleItem(
  bundleValue: unknown,
  itemId: string,
  replacementValue: unknown,
): IntentBundleDraft {
  const bundle = IntentBundleDraftV1.parse(bundleValue);
  const replacement = ClarifiedIntentBundleItemV1.parse(replacementValue) as ClarifiedIntentBundleItem;
  const index = bundle.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) throw new IntentInterpreterError("INVALID_MODEL_OUTPUT", "The clarified bundle item does not exist.");
  const items = bundle.items.map((item, itemIndex) => itemIndex === index ? { itemId, ...replacement } : item);
  return IntentBundleDraftV1.parse({ ...bundle, items });
}

function assignStableItemIds(value: unknown, itemIdFactory: IntentBundleItemIdFactory): unknown {
  if (!isRecord(value) || !Array.isArray(value.items)) return value;
  const originalIds = value.items.map((item) => isRecord(item) && typeof item.itemId === "string" ? item.itemId : undefined);
  const definedIds = originalIds.filter((itemId): itemId is string => itemId !== undefined);
  if (new Set(definedIds).size !== definedIds.length) return value;

  const stableIds = value.items.map((_item, index) => itemIdFactory(index));
  if (new Set(stableIds).size !== stableIds.length || stableIds.some((itemId) => itemId.trim().length === 0)) return value;
  const idMap = new Map<string, string>();
  originalIds.forEach((originalId, index) => {
    const stableId = stableIds[index];
    if (originalId !== undefined && stableId !== undefined) idMap.set(originalId, stableId);
  });

  return {
    ...value,
    items: value.items.map((item, index) => isRecord(item) ? { ...item, itemId: stableIds[index] } : item),
    ...(Array.isArray(value.explicitDependencies) ? {
      explicitDependencies: value.explicitDependencies.map((dependency) => isRecord(dependency) ? {
        ...dependency,
        beforeItemId: typeof dependency.beforeItemId === "string" ? idMap.get(dependency.beforeItemId) ?? dependency.beforeItemId : dependency.beforeItemId,
        afterItemId: typeof dependency.afterItemId === "string" ? idMap.get(dependency.afterItemId) ?? dependency.afterItemId : dependency.afterItemId,
      } : dependency),
    } : {}),
  };
}

/**
 * Treats model order and dependency endpoints as untrusted. When source action types map exactly to
 * bundle items, source order becomes canonical and only explicit source-language edges are retained.
 * If the item set cannot be matched safely, the original bundle is left intact for validation to fail.
 */
function alignBundleToSource(bundle: IntentBundleDraft, sourceText: string): IntentBundleDraft {
  const signals = bundleActionSignals(sourceText);
  const lastAction = signals.at(-1);
  const explicitTrailingMinimums = lastAction === undefined ? [] : sourceMinimumBalanceMoneyAfter(sourceText, lastAction.end);
  const globalConstraints = [...bundle.globalConstraints];
  for (const money of explicitTrailingMinimums) {
    const alreadyPresent = globalConstraints.some((constraint) =>
      constraint.type === "MIN_AVAILABLE_BALANCE"
      && constraint.money.currency === money.currency
      && constraint.money.minorUnits === money.minorUnits
    );
    if (!alreadyPresent) globalConstraints.push({ type: "MIN_AVAILABLE_BALANCE", money });
  }
  const sourceBackedBundle = IntentBundleDraftV1.parse({ ...bundle, globalConstraints });
  if (signals.length !== bundle.items.length) return sourceBackedBundle;

  const remaining = [...sourceBackedBundle.items];
  const items: IntentBundleDraft["items"][number][] = [];
  for (const signal of signals) {
    const matchingIndex = remaining.findIndex((item) => item.goal.type === signal.type);
    if (matchingIndex < 0) return sourceBackedBundle;
    const [matchingItem] = remaining.splice(matchingIndex, 1);
    if (matchingItem === undefined) return sourceBackedBundle;
    items.push(matchingItem);
  }

  const explicitDependencies = explicitBundleOrderSignals(sourceText, signals).map(({ beforeIndex, afterIndex }) => ({
    beforeItemId: items[beforeIndex]!.itemId,
    afterItemId: items[afterIndex]!.itemId,
    reason: "USER_EXPLICIT_ORDER" as const,
  }));
  return IntentBundleDraftV1.parse({ ...sourceBackedBundle, items, explicitDependencies });
}

function validationIssues(error: z.ZodError): readonly IntentValidationIssue[] {
  return error.issues.map(({ path, code, message }) => ({
    path: path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
    code,
    message,
  }));
}

function modelDiagnostic(error: unknown): ModelClientDiagnostic | undefined {
  if (!(error instanceof Error)) return undefined;
  return (error as ModelClientDiagnosticError).diagnostic;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
