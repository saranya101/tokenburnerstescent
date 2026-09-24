import { normalizeEntityReference } from "../grounding/normalizer.js";
import { compareSemanticCandidates, semanticCandidateLimit } from "./ranking.js";
import type { SemanticEntityCandidate, SemanticEntityRetriever, SemanticEntityRetrievalInput } from "./types.js";

/** Deterministic fake retriever for tests; it makes no model, API, or database call. */
export class InMemorySemanticEntityRetriever implements SemanticEntityRetriever {
  constructor(private readonly candidatesByReference: ReadonlyMap<string, readonly SemanticEntityCandidate[]>) {}

  async retrieve(input: SemanticEntityRetrievalInput): Promise<readonly SemanticEntityCandidate[]> {
    const candidates = this.candidatesByReference.get(normalizeEntityReference(input.reference)) ?? [];
    return candidates
      .filter((candidate) => input.expectedEntityType === undefined || candidate.entityType === input.expectedEntityType)
      .sort(compareSemanticCandidates)
      .slice(0, semanticCandidateLimit(input.limit));
  }
}
