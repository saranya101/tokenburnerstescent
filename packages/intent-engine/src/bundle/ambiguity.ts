import { clarificationFor } from "../ambiguity/clarification.js";
import { DeterministicIntentAmbiguityDetector } from "../ambiguity/detector.js";
import type { ClarificationItem } from "../ambiguity/types.js";
import type { EntityGroundingResult, GroundableEntityType } from "../grounding/types.js";
import { groundingRequirementsForIntentBundle, intentDraftForBundleItem } from "./grounding.js";
import type {
  IntentBundleAmbiguityAnalysisInput,
  IntentBundleAmbiguityAnalysisResult,
  IntentBundleAmbiguityDetector,
  IntentBundleItemAmbiguityResult,
} from "./types.js";

/** Keeps ambiguity and clarification state isolated to the item or global field that caused it. */
export class DeterministicIntentBundleAmbiguityDetector implements IntentBundleAmbiguityDetector {
  constructor(private readonly itemDetector = new DeterministicIntentAmbiguityDetector()) {}

  analyze(input: IntentBundleAmbiguityAnalysisInput): IntentBundleAmbiguityAnalysisResult {
    const itemResults = new Map(input.itemGroundingResults.map((entry) => [entry.itemId, entry.groundingResults]));
    const items: IntentBundleItemAmbiguityResult[] = input.bundle.items.map((item, index) => {
      const result = this.itemDetector.analyze({
        draft: intentDraftForBundleItem(item),
        groundingResults: itemResults.get(item.itemId) ?? [],
      });
      return result.status === "CLEAR"
        ? { itemId: item.itemId, status: "CLEAR" }
        : {
            itemId: item.itemId,
            status: "NEEDS_CLARIFICATION",
            clarifications: result.clarifications.map((clarification) => ({
              ...clarification,
              field: `items[${index}].${clarification.field}`,
            })),
          };
    });

    const globalClarifications = globalRequirements(input).map((requirement) => {
      const grounding = matchingGrounding(input.globalGroundingResults, requirement.reference, requirement.expectedEntityType);
      return grounding?.status === "RESOLVED"
        ? undefined
        : clarificationFor(requirement.field, requirement.reference, requirement.expectedEntityType, grounding);
    }).filter((item): item is ClarificationItem => item !== undefined);

    const needsClarification = globalClarifications.length > 0 || items.some((item) => item.status === "NEEDS_CLARIFICATION");
    return needsClarification
      ? { status: "NEEDS_CLARIFICATION", items, globalClarifications }
      : { status: "CLEAR", items, globalClarifications: [] };
  }
}

function globalRequirements(input: IntentBundleAmbiguityAnalysisInput) {
  return groundingRequirementsForIntentBundle(input.bundle).filter((requirement) => requirement.scope === "GLOBAL");
}

function matchingGrounding(
  results: readonly EntityGroundingResult[],
  reference: string,
  expectedEntityType: GroundableEntityType | undefined,
): EntityGroundingResult | undefined {
  return results.find((result) => result.reference === reference && matchesExpectedType(result, expectedEntityType));
}

function matchesExpectedType(result: EntityGroundingResult, expectedEntityType: GroundableEntityType | undefined): boolean {
  if (expectedEntityType === undefined) return true;
  if (result.status === "RESOLVED") return result.entityType === expectedEntityType;
  if (result.expectedEntityType === expectedEntityType) return true;
  return result.status !== "NOT_FOUND" && result.candidates.some((candidate) => candidate.entityType === expectedEntityType);
}
