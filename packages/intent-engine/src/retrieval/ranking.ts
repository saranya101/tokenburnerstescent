import type { SemanticEntityCandidate } from "./types.js";

export const DEFAULT_SEMANTIC_CANDIDATE_LIMIT = 5;
export const MAX_SEMANTIC_CANDIDATE_LIMIT = 10;

/** Clamps caller-requested top-k retrieval to a small, predictable range. */
export function semanticCandidateLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEMANTIC_CANDIDATE_LIMIT;
  return Math.min(MAX_SEMANTIC_CANDIDATE_LIMIT, Math.max(1, Math.floor(limit)));
}

export function compareSemanticCandidates(left: SemanticEntityCandidate, right: SemanticEntityCandidate): number {
  return right.similarityScore - left.similarityScore
    || left.entityType.localeCompare(right.entityType)
    || left.entityId.localeCompare(right.entityId);
}
