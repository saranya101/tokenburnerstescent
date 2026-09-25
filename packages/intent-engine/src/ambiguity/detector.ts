import type { IntentDraftV1 } from "@parlance/contracts";
import { clarificationFor } from "./clarification.js";
import type { EntityGroundingResult, GroundableEntityType } from "../grounding/types.js";
import type { AmbiguityAnalysisResult, ClarificationItem, IntentAmbiguityAnalysisInput, IntentAmbiguityDetector } from "./types.js";

type ReferenceOccurrence = { field: string; reference: string; expectedEntityType?: GroundableEntityType };

/**
 * Deterministic pre-contract ambiguity gate. It never infers identity from an LLM or similarity
 * score, and unresolved results must be clarified before any GoalContractV1 reaches the compiler.
 */
export class DeterministicIntentAmbiguityDetector implements IntentAmbiguityDetector {
  analyze(input: IntentAmbiguityAnalysisInput): AmbiguityAnalysisResult {
    const seen = new Set<string>();
    const clarifications: ClarificationItem[] = [];
    for (const occurrence of referenceOccurrences(input.draft)) {
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

function referenceOccurrences(draft: IntentDraftV1): readonly ReferenceOccurrence[] {
  const occurrences: ReferenceOccurrence[] = [];
  switch (draft.goal.type) {
    case "DELIVER_MONEY": occurrences.push({ field: "goal.recipientReference", reference: draft.goal.recipientReference, expectedEntityType: "BENEFICIARY" }); break;
    case "ACQUIRE_ASSET": occurrences.push({ field: "goal.assetReference", reference: draft.goal.assetReference, expectedEntityType: "ASSET" }); break;
    case "PAY_BILL": occurrences.push({ field: "goal.billerReference", reference: draft.goal.billerReference, expectedEntityType: "BILLER" }); break;
    case "MOVE_FUNDS":
      if (draft.goal.sourceAccountReference !== undefined) occurrences.push({ field: "goal.sourceAccountReference", reference: draft.goal.sourceAccountReference, expectedEntityType: "ACCOUNT" });
      occurrences.push({ field: "goal.destinationAccountReference", reference: draft.goal.destinationAccountReference, expectedEntityType: "ACCOUNT" });
      break;
  }
  draft.constraints.forEach((constraint, index) => {
    if (constraint.type === "EXCLUDED_ACCOUNT") occurrences.push({ field: `constraints[${index}].accountReference`, reference: constraint.accountReference, expectedEntityType: "ACCOUNT" });
    if (constraint.type === "MIN_AVAILABLE_BALANCE" && constraint.accountReference !== undefined) occurrences.push({ field: `constraints[${index}].accountReference`, reference: constraint.accountReference, expectedEntityType: "ACCOUNT" });
  });
  draft.preferences.forEach((preference, index) => {
    if (preference.type === "PREFER_ACCOUNT") occurrences.push({ field: `preferences[${index}].accountReference`, reference: preference.accountReference, expectedEntityType: "ACCOUNT" });
  });
  draft.references.forEach((reference, index) => {
    const field = `references[${index}].reference`;
    if (reference.expectedEntityType === undefined) occurrences.push({ field, reference: reference.reference });
    else occurrences.push({ field, reference: reference.reference, expectedEntityType: reference.expectedEntityType });
  });
  return occurrences;
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
