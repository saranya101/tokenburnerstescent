# Semantic entity retrieval

Semantic retrieval is recall-oriented candidate discovery only. A similarity score is normalized to `0..1`, but is never identity proof, authorization, or a reason to create an operation or invoke the compiler. `CANDIDATES` remains distinct from `RESOLVED`; canonical identity requires deterministic grounding or later user clarification.

`PgVectorSemanticEntityRetriever` queries the current user-scoped `EntityAlias.embedding`
`vector(1536)` column with pgvector cosine distance (`<=>`). It converts distance to the existing
score contract with `clamp(1 - cosineDistance, 0, 1)`, deduplicates aliases by entity, orders ties
by entity type and ID, and enforces the shared top-k limit. Results remain `CANDIDATES`; the score
never confirms identity and the adapter never constructs a `GoalContractV1`.

The current database can safely join aliases to canonical names only for user-owned beneficiaries
and assets represented by a user holding. Accounts have no human display-name column, and billers
and obligations have no canonical tables. Those types deliberately return no DB candidates.

Embedding generation is injected through `SemanticReferenceEmbedder`. No TokenHub or other
embedding provider is selected by this package.
