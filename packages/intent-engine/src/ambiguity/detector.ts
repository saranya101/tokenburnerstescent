import { clarificationFor } from "./clarification.js";
import type { EntityGroundingResult, GroundableEntityType } from "../grounding/types.js";
import type { AmbiguityAnalysisResult, ClarificationItem, IntentAmbiguityAnalysisInput, IntentAmbiguityDetector } from "./types.js";
import { intentReferenceOccurrences } from "../references.js";

/**
 * Deterministic pre-contract ambiguity gate. It never infers identity from an LLM or similarity
 * score, and unresolved results must be clarified before any GoalContractV1 reaches the compiler.
 */
export class DeterministicIntentAmbiguityDetector implements IntentAmbiguityDetector {
  analyze(input: IntentAmbiguityAnalysisInput): AmbiguityAnalysisResult {
    const seen = new Set<string>();
    const clarifications: ClarificationItem[] = [];
    for (const occurrence of intentReferenceOccurrences(input.draft)) {
      const key = `${occurrence.reference}\u0000${occurrence.expectedEntityType ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const grounding = matchingGrounding(input.groundingResults, occurrence.reference, occurrence.expectedEntityType);
      if (grounding?.status === "RESOLVED") continue;
      clarifications.push(clarificationFor(occurrence.field, occurrence.reference, occurrence.expectedEntityType, grounding));
    }
    return clarifications.length === 0 ? { status: "CLEAR" } : { status: "NEEDS_CLARIFICATION", clarifications };
  }
}

function matchingGrounding(results: readonly EntityGroundingResult[], reference: string, expectedEntityType: GroundableEntityType | undefined): EntityGroundingResult | undefined {
  return results.find((result) => result.reference === reference && matchesExpectedType(result, expectedEntityType));
}

function matchesExpectedType(result: EntityGroundingResult, expectedEntityType: GroundableEntityType | undefined): boolean {
  if (expectedEntityType === undefined) return true;
  if (result.status === "RESOLVED") return result.entityType === expectedEntityType;
  if (result.expectedEntityType === expectedEntityType) return true;
  return result.status !== "NOT_FOUND" && result.candidates.some((candidate) => candidate.entityType === expectedEntityType);
}
