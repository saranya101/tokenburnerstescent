import { normalizeEntityReference } from "./normalizer.js";
import { EntityGroundingError } from "./errors.js";
import { compareSemanticCandidates } from "../retrieval/ranking.js";
import type { SemanticEntityCandidate, SemanticEntityRetriever } from "../retrieval/types.js";
import type { EntityGrounder, EntityGroundingInput, EntityGroundingResult, EntityRepository, GroundableEntityType, GroundingCandidate, GroundingEntity, GroundingResolutionMethod } from "./types.js";

/** Deterministic exact/alias entity grounder. It never invents an entity ID. */
export class DeterministicEntityGrounder implements EntityGrounder {
  constructor(private readonly repository: EntityRepository, private readonly semanticRetriever?: SemanticEntityRetriever) {}

  async ground(input: EntityGroundingInput): Promise<EntityGroundingResult> {
    const normalizedReference = normalizeEntityReference(input.reference);
    const exactMatches = candidates(this.repository.findByCanonicalName(normalizedReference, input.expectedEntityType), input.expectedEntityType);
    if (exactMatches.length > 0) {
      return resultForMatches(input, exactMatches, "EXACT");
    }

    const aliasMatches = candidates(this.repository.findByAlias(normalizedReference, input.expectedEntityType), input.expectedEntityType);
    if (aliasMatches.length > 0) {
      return resultForMatches(input, aliasMatches, "ALIAS");
    }
    if (input.semanticSearch === undefined) return notFoundResult(input);
    if (this.semanticRetriever === undefined) {
      throw new EntityGroundingError("SEMANTIC_RETRIEVER_UNAVAILABLE", "Semantic candidate retrieval is not configured.");
    }
    return this.semanticCandidates(input);
  }

  private async semanticCandidates(input: EntityGroundingInput): Promise<EntityGroundingResult> {
    try {
      const retrievalInput = semanticRetrievalInput(input);
      const candidates = (await this.semanticRetriever?.retrieve(retrievalInput) ?? [])
        .filter((candidate) => input.expectedEntityType === undefined || candidate.entityType === input.expectedEntityType)
        .sort(compareSemanticCandidates);
      if (candidates.length === 0) return notFoundResult(input);
      return semanticCandidatesResult(input, candidates);
    } catch (error) {
      if (error instanceof EntityGroundingError) throw error;
      throw new EntityGroundingError("SEMANTIC_RETRIEVAL_ERROR", "Semantic candidate retrieval failed.");
    }
  }
}

function semanticRetrievalInput(input: EntityGroundingInput) {
  const limit = input.semanticSearch?.limit;
  if (input.expectedEntityType === undefined) {
    return limit === undefined ? { reference: input.reference } : { reference: input.reference, limit };
  }
  return limit === undefined
    ? { reference: input.reference, expectedEntityType: input.expectedEntityType }
    : { reference: input.reference, expectedEntityType: input.expectedEntityType, limit };
}

function resultForMatches(input: EntityGroundingInput, matches: readonly GroundingCandidate[], resolutionMethod: GroundingResolutionMethod): EntityGroundingResult {
  if (matches.length === 1) {
    const match = matches[0];
    if (match === undefined) throw new Error("Grounding match unexpectedly missing.");
    return { status: "RESOLVED", reference: input.reference, entityType: match.entityType, entityId: match.entityId, resolutionMethod };
  }
  return ambiguousResult(input, matches);
}

function ambiguousResult(input: EntityGroundingInput, matches: readonly GroundingCandidate[]): EntityGroundingResult {
  if (input.expectedEntityType === undefined) {
    return { status: "AMBIGUOUS", reference: input.reference, candidates: matches };
  }
  return { status: "AMBIGUOUS", reference: input.reference, expectedEntityType: input.expectedEntityType, candidates: matches };
}

function notFoundResult(input: EntityGroundingInput): EntityGroundingResult {
  if (input.expectedEntityType === undefined) {
    return { status: "NOT_FOUND", reference: input.reference };
  }
  return { status: "NOT_FOUND", reference: input.reference, expectedEntityType: input.expectedEntityType };
}

function semanticCandidatesResult(input: EntityGroundingInput, candidates: readonly SemanticEntityCandidate[]): EntityGroundingResult {
  if (input.expectedEntityType === undefined) {
    return { status: "CANDIDATES", reference: input.reference, candidates };
  }
  return { status: "CANDIDATES", reference: input.reference, expectedEntityType: input.expectedEntityType, candidates };
}

function candidates(entities: readonly GroundingEntity[], expectedEntityType: GroundableEntityType | undefined): readonly GroundingCandidate[] {
  const unique = new Map<string, GroundingCandidate>();
  for (const entity of entities) {
    if (expectedEntityType === undefined || entity.entityType === expectedEntityType) {
      unique.set(`${entity.entityType}\u0000${entity.entityId}`, { entityType: entity.entityType, entityId: entity.entityId, canonicalName: entity.canonicalName });
    }
  }
  return [...unique.values()].sort((left, right) => left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId));
}
