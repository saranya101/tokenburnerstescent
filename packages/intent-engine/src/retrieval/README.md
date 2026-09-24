# Semantic entity retrieval

Semantic retrieval is recall-oriented candidate discovery only. A similarity score is normalized to `0..1`, but is never identity proof, authorization, or a reason to create an operation or invoke the compiler. `CANDIDATES` remains distinct from `RESOLVED`; canonical identity requires deterministic grounding or later user clarification.

A future Person A `PgVectorEntityRetriever` should implement `SemanticEntityRetriever` by querying searchable `EntityAlias`/entity text plus stored embeddings and returning `entityType`, `entityId`, `canonicalName`, optional matched text, and normalized similarity score. It must filter by expected entity type, rank deterministically, and enforce a safe top-k limit. It must not construct a `GoalContractV1`.
