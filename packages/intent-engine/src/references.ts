import type { IntentDraftV1 } from "@parlance/contracts";
import type { GroundableEntityType } from "./grounding/types.js";

export type IntentReferenceOccurrence = {
  field: string;
  reference: string;
  expectedEntityType?: GroundableEntityType;
};

/** Returns every human reference that must be grounded before a goal candidate can be built. */
export function intentReferenceOccurrences(draft: IntentDraftV1): readonly IntentReferenceOccurrence[] {
  const occurrences: IntentReferenceOccurrence[] = [];
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
    occurrences.push(reference.expectedEntityType === undefined
      ? { field, reference: reference.reference }
      : { field, reference: reference.reference, expectedEntityType: reference.expectedEntityType });
  });
  return occurrences;
}
