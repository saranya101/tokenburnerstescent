import { DeterministicEntityGrounder } from "./grounder.js";
import { DbEntityRepository } from "./db-repository.js";
import type { GroundingRawQueryClient } from "./db-types.js";
import { PgVectorSemanticEntityRetriever, type SemanticReferenceEmbedder } from "../retrieval/pgvector.js";

export interface DbGroundingStackOptions {
  readonly client: GroundingRawQueryClient;
  readonly userId: string;
  readonly embedder: SemanticReferenceEmbedder;
}

/** Composition only; it does not alter exact/alias/semantic grounding precedence. */
export function createDbGroundingStack(options: DbGroundingStackOptions) {
  const repository = new DbEntityRepository(options.client, options.userId);
  const semanticRetriever = new PgVectorSemanticEntityRetriever(options.client, options.userId, options.embedder);
  const grounder = new DeterministicEntityGrounder(repository, semanticRetriever);
  return { repository, semanticRetriever, grounder };
}
