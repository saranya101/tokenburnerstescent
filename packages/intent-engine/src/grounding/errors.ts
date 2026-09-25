export type EntityGroundingErrorCode = "SEMANTIC_RETRIEVER_UNAVAILABLE" | "SEMANTIC_RETRIEVAL_ERROR";

/** Sanitized boundary error: provider/database details are intentionally not exposed. */
export class EntityGroundingError extends Error {
  readonly name = "EntityGroundingError";
  constructor(readonly code: EntityGroundingErrorCode, message: string) { super(message); }
}
