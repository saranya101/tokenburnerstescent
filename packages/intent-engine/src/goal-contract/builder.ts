import { type EntityBinding, type IntentDraftV1 } from "@parlance/contracts";
import { GoalContractBuilderError } from "./errors.js";
import { GoalContractCandidateV1, type GoalContractBuildInput, type GoalContractBuilder, type GoalContractCandidate, type GoalContractValidationIssue } from "./types.js";
import type { EntityGroundingResult, GroundableEntityType } from "../grounding/types.js";
import { intentReferenceOccurrences, type IntentReferenceOccurrence } from "../references.js";

type ResolvedGrounding = Extract<EntityGroundingResult, { status: "RESOLVED" }>;

/**
 * Converts validated human-language intent into the canonical-ID handoff boundary. No unresolved
 * grounding result, candidate, or human reference reaches downstream planning through this builder.
 */
export class DeterministicGoalContractBuilder implements GoalContractBuilder {
  build(input: GoalContractBuildInput): GoalContractCandidate {
    assertConsistentBindings(input.groundingResults);
    const resolver = new ReferenceResolver(input.groundingResults);
    const candidate = {
      schemaVersion: "1",
      goal: groundedGoal(input.draft, resolver),
      constraints: groundedConstraints(input.draft, resolver),
      preferences: groundedPreferences(input.draft, resolver),
      entityBindings: entityBindings(intentReferenceOccurrences(input.draft), resolver),
    };
    const parsed = GoalContractCandidateV1.safeParse(candidate);
    if (!parsed.success) {
      throw new GoalContractBuilderError("INVALID_GOAL_CONTRACT", "The canonical goal contract is invalid.", undefined, validationIssues(parsed.error));
    }
    return parsed.data;
  }
}

function groundedGoal(draft: IntentDraftV1, resolver: ReferenceResolver): unknown {
  switch (draft.goal.type) {
    case "DELIVER_MONEY": return { type: "DELIVER_MONEY", amount: draft.goal.amount, recipientId: resolver.resolve("goal.recipientReference", draft.goal.recipientReference, "BENEFICIARY").entityId };
    case "ACQUIRE_ASSET": return {
      type: "ACQUIRE_ASSET", assetId: resolver.resolve("goal.assetReference", draft.goal.assetReference, "ASSET").entityId,
      ...(draft.goal.budget === undefined ? {} : { budget: draft.goal.budget }),
      ...(draft.goal.quantity === undefined ? {} : { quantity: draft.goal.quantity }),
    };
    case "PAY_BILL": return {
      type: "PAY_BILL", billerId: resolver.resolve("goal.billerReference", draft.goal.billerReference, "BILLER").entityId,
      ...(draft.goal.amount === undefined ? {} : { amount: draft.goal.amount }),
    };
    case "MOVE_FUNDS": return {
      type: "MOVE_FUNDS", amount: draft.goal.amount,
      ...(draft.goal.sourceAccountReference === undefined ? {} : { sourceAccountId: resolver.resolve("goal.sourceAccountReference", draft.goal.sourceAccountReference, "ACCOUNT").entityId }),
      destinationAccountId: resolver.resolve("goal.destinationAccountReference", draft.goal.destinationAccountReference, "ACCOUNT").entityId,
    };
  }
}

function groundedConstraints(draft: IntentDraftV1, resolver: ReferenceResolver): readonly unknown[] {
  return draft.constraints.map((constraint, index) => {
    switch (constraint.type) {
      case "MAX_TOTAL_COST": return constraint;
      case "MAX_LOCK_IN_DAYS": return constraint;
      case "EXCLUDED_ACCOUNT": return { type: "EXCLUDED_ACCOUNT", accountId: resolver.resolve(`constraints[${index}].accountReference`, constraint.accountReference, "ACCOUNT").entityId };
      case "MIN_AVAILABLE_BALANCE": return {
        type: "MIN_AVAILABLE_BALANCE", money: constraint.money,
        ...(constraint.accountReference === undefined ? {} : { accountId: resolver.resolve(`constraints[${index}].accountReference`, constraint.accountReference, "ACCOUNT").entityId }),
      };
    }
  });
}

function groundedPreferences(draft: IntentDraftV1, resolver: ReferenceResolver): readonly unknown[] {
  return draft.preferences.map((preference, index) => preference.type === "PREFER_ACCOUNT"
    ? { type: "PREFER_ACCOUNT", accountId: resolver.resolve(`preferences[${index}].accountReference`, preference.accountReference, "ACCOUNT").entityId }
    : preference);
}

function entityBindings(occurrences: readonly IntentReferenceOccurrence[], resolver: ReferenceResolver): readonly EntityBinding[] {
  const bindings = new Map<string, EntityBinding>();
  for (const occurrence of occurrences) {
    const grounding = resolver.resolve(occurrence.field, occurrence.reference, occurrence.expectedEntityType);
    const key = `${grounding.reference}\u0000${grounding.entityType}\u0000${grounding.entityId}`;
    const existing = bindings.get(key);
    if (existing === undefined || resolutionRank(grounding.resolutionMethod) < resolutionRank(existing.resolutionMethod)) {
      bindings.set(key, { schemaVersion: "1", reference: grounding.reference, entityType: grounding.entityType, entityId: grounding.entityId, resolutionMethod: grounding.resolutionMethod, confirmed: false });
    }
  }
  return [...bindings.values()].sort((left, right) => left.reference.localeCompare(right.reference) || left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId));
}

class ReferenceResolver {
  constructor(private readonly results: readonly EntityGroundingResult[]) {}

  resolve(field: string, reference: string, expectedEntityType?: GroundableEntityType): ResolvedGrounding {
    const sameReference = this.results.filter((result) => result.reference === reference);
    if (sameReference.length === 0) {
      throw new GoalContractBuilderError("MISSING_GROUNDING", "A required reference has no grounding result.", [errorDetail(field, reference, expectedEntityType)]);
    }
    const unresolved = sameReference.find((result) => result.status !== "RESOLVED");
    if (unresolved !== undefined) {
      throw new GoalContractBuilderError("UNRESOLVED_REFERENCE", "A required reference is not fully resolved.", [errorDetail(field, reference, expectedEntityType)]);
    }
    const resolved = sameReference as readonly ResolvedGrounding[];
    const wrongType = expectedEntityType === undefined ? undefined : resolved.find((result) => result.entityType !== expectedEntityType);
    if (wrongType !== undefined) {
      throw new GoalContractBuilderError("TYPE_MISMATCH", "A reference resolved to an unexpected entity type.", [errorDetail(field, reference, expectedEntityType)]);
    }
    const ids = [...new Set(resolved.map((result) => result.entityId))];
    if (ids.length !== 1) {
      throw new GoalContractBuilderError("INCONSISTENT_BINDING", "A reference resolved to inconsistent canonical IDs.", [{ ...errorDetail(field, reference, expectedEntityType), entityIds: ids }]);
    }
    const selected = resolved.slice().sort((left, right) => resolutionRank(left.resolutionMethod) - resolutionRank(right.resolutionMethod))[0];
    if (selected === undefined || selected.entityId.trim().length === 0) {
      throw new GoalContractBuilderError("MISSING_GROUNDING", "A required reference has no canonical entity ID.", [errorDetail(field, reference, expectedEntityType)]);
    }
    return selected;
  }
}

function errorDetail(field: string, reference: string, expectedEntityType: GroundableEntityType | undefined): { field: string; reference: string; expectedEntityType?: string } {
  return expectedEntityType === undefined ? { field, reference } : { field, reference, expectedEntityType };
}

function assertConsistentBindings(results: readonly EntityGroundingResult[]): void {
  const idsByReference = new Map<string, Set<string>>();
  for (const result of results) {
    if (result.status !== "RESOLVED") continue;
    const ids = idsByReference.get(result.reference) ?? new Set<string>();
    ids.add(`${result.entityType}\u0000${result.entityId}`);
    idsByReference.set(result.reference, ids);
  }
  for (const [reference, entityKeys] of idsByReference) {
    if (entityKeys.size > 1) {
      throw new GoalContractBuilderError("INCONSISTENT_BINDING", "A human reference has inconsistent canonical bindings.", [{ reference, entityIds: [...entityKeys].map((value) => value.split("\u0000")[1] ?? value) }]);
    }
  }
}

function resolutionRank(method: EntityBinding["resolutionMethod"]): number {
  switch (method) {
    case "EXACT": return 0;
    case "ALIAS": return 1;
    case "USER_CONFIRMED": return 2;
    case "SEMANTIC": return 3;
  }
}

function validationIssues(error: { issues: readonly { path?: readonly PropertyKey[]; code: string; message: string }[] }): readonly GoalContractValidationIssue[] {
  return error.issues.map(({ path, code, message }) => ({
    path: (path ?? []).filter((part): part is string | number => typeof part === "string" || typeof part === "number"), code, message,
  }));
}
