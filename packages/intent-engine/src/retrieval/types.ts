import type { EntityBinding } from "@parlance/contracts";

export type SemanticEntityType = EntityBinding["entityType"];

export interface SemanticEntityRetrievalInput {
  reference: string;
  expectedEntityType?: SemanticEntityType;
  /** Requested top-k count. Implementations clamp this to a documented safe maximum. */
  limit?: number;
}

/**
 * Untrusted, recall-oriented semantic search output. similarityScore is normalized to [0, 1],
 * where higher means more text similarity; it is never proof of identity or authorization.
 */
export interface SemanticEntityCandidate {
  entityId: string;
  entityType: SemanticEntityType;
  canonicalName: string;
  matchedText?: string;
  similarityScore: number;
}

/** Future pgvector adapters provide ranked, untrusted candidate data through this boundary. */
export interface SemanticEntityRetriever {
  retrieve(input: SemanticEntityRetrievalInput): Promise<readonly SemanticEntityCandidate[]>;
}
