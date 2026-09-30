import type { GroundingRawQueryClient } from "../grounding/db-types.js";
import { compareSemanticCandidates, semanticCandidateLimit } from "./ranking.js";
import type { SemanticEntityCandidate, SemanticEntityRetriever, SemanticEntityRetrievalInput, SemanticEntityType } from "./types.js";

export const ENTITY_ALIAS_EMBEDDING_DIMENSIONS = 1536;

/** Provider-neutral embedding boundary. B6 intentionally supplies no production provider. */
export interface SemanticReferenceEmbedder {
  embedReference(reference: string): Promise<readonly number[]>;
}

interface SemanticEntityRow {
  readonly ownerUserId: unknown;
  readonly entityType: unknown;
  readonly entityId: unknown;
  readonly canonicalName: unknown;
  readonly matchedText: unknown;
  readonly cosineDistance: unknown;
}

interface RankedRow {
  readonly entityId: string;
  readonly entityType: Extract<SemanticEntityType, "BENEFICIARY" | "ASSET">;
  readonly canonicalName: string;
  readonly matchedText: string;
  readonly cosineDistance: number;
}

/** User-scoped cosine-distance search over EntityAlias.embedding. Results remain candidates only. */
export class PgVectorSemanticEntityRetriever implements SemanticEntityRetriever {
  constructor(
    private readonly client: GroundingRawQueryClient,
    private readonly userId: string,
    private readonly embedder: SemanticReferenceEmbedder,
  ) {
    if (userId.trim().length === 0) throw new Error("PgVectorSemanticEntityRetriever requires a userId.");
  }

  async retrieve(input: SemanticEntityRetrievalInput): Promise<readonly SemanticEntityCandidate[]> {
    const query = semanticQuery(input.expectedEntityType);
    if (query === undefined) return [];
    const limit = semanticCandidateLimit(input.limit);
    const embedding = await this.embedder.embedReference(input.reference);
    const vector = pgVectorLiteral(embedding);
    const rows = await this.client.$queryRawUnsafe<readonly SemanticEntityRow[]>(query, this.userId, vector, limit);
    return rankRows(rows, this.userId, input.expectedEntityType).slice(0, limit);
  }
}

/** Converts pgvector cosine distance to the existing score contract: clamp(1 - distance, 0, 1). */
export function cosineDistanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.min(1, Math.max(0, 1 - distance));
}

function semanticQuery(expectedEntityType: SemanticEntityType | undefined): string | undefined {
  const branches = semanticBranches(expectedEntityType);
  if (branches.length === 0) return undefined;
  return `WITH eligible_aliases AS (
${branches.join("\nUNION ALL\n")}
), distances AS (
  SELECT "ownerUserId", "entityType", "entityId", "canonicalName", "matchedText",
    (embedding <=> $2::vector)::double precision AS "cosineDistance"
  FROM eligible_aliases
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY "entityType", "entityId"
    ORDER BY "cosineDistance" ASC, "matchedText" ASC
  ) AS "entityRank"
  FROM distances
)
SELECT "ownerUserId", "entityType", "entityId", "canonicalName", "matchedText", "cosineDistance"
FROM ranked
WHERE "entityRank" = 1
ORDER BY "cosineDistance" ASC, "entityType" ASC, "entityId" ASC, "matchedText" ASC
LIMIT $3`;
}

function semanticBranches(expectedEntityType: SemanticEntityType | undefined): string[] {
  const branches: string[] = [];
  if (expectedEntityType === undefined || expectedEntityType === "BENEFICIARY") {
    branches.push(`  SELECT ea."userId" AS "ownerUserId", 'BENEFICIARY' AS "entityType", b.id AS "entityId",
    b.name AS "canonicalName", ea.alias AS "matchedText", ea.embedding
  FROM "EntityAlias" ea
  JOIN "Beneficiary" b ON b.id = ea."entityId" AND b."userId" = ea."userId"
  WHERE ea."userId" = $1 AND ea."entityType" = 'BENEFICIARY' AND ea.embedding IS NOT NULL`);
  }
  if (expectedEntityType === undefined || expectedEntityType === "ASSET") {
    branches.push(`  SELECT ea."userId" AS "ownerUserId", 'ASSET' AS "entityType", a.id AS "entityId",
    a.name AS "canonicalName", ea.alias AS "matchedText", ea.embedding
  FROM "EntityAlias" ea
  JOIN "Holding" h ON h."assetId" = ea."entityId" AND h."userId" = ea."userId"
  JOIN "Asset" a ON a.id = h."assetId"
  WHERE ea."userId" = $1 AND ea."entityType" = 'ASSET' AND ea.embedding IS NOT NULL`);
  }
  return branches;
}

function pgVectorLiteral(embedding: readonly number[]): string {
  if (embedding.length !== ENTITY_ALIAS_EMBEDDING_DIMENSIONS || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error(`Semantic reference embeddings must contain exactly ${ENTITY_ALIAS_EMBEDDING_DIMENSIONS} finite dimensions.`);
  }
  return `[${embedding.join(",")}]`;
}

function rankRows(
  rows: readonly SemanticEntityRow[],
  userId: string,
  expectedEntityType: SemanticEntityType | undefined,
): SemanticEntityCandidate[] {
  const valid: RankedRow[] = [];
  for (const row of rows) {
    if (row.ownerUserId !== userId || !isSupportedType(row.entityType)) continue;
    if (expectedEntityType !== undefined && row.entityType !== expectedEntityType) continue;
    const distance = typeof row.cosineDistance === "number"
      ? row.cosineDistance
      : typeof row.cosineDistance === "string"
        ? Number(row.cosineDistance)
        : Number.NaN;
    if (
      typeof row.entityId !== "string" || row.entityId.length === 0
      || typeof row.canonicalName !== "string" || row.canonicalName.trim().length === 0
      || typeof row.matchedText !== "string" || row.matchedText.trim().length === 0
      || !Number.isFinite(distance)
    ) continue;
    valid.push({
      entityId: row.entityId,
      entityType: row.entityType,
      canonicalName: row.canonicalName,
      matchedText: row.matchedText,
      cosineDistance: distance,
    });
  }
  valid.sort((left, right) => left.cosineDistance - right.cosineDistance
    || left.entityType.localeCompare(right.entityType)
    || left.entityId.localeCompare(right.entityId)
    || left.matchedText.localeCompare(right.matchedText));
  const unique = new Map<string, SemanticEntityCandidate>();
  for (const row of valid) {
    const key = `${row.entityType}\u0000${row.entityId}`;
    if (!unique.has(key)) {
      unique.set(key, {
        entityId: row.entityId,
        entityType: row.entityType,
        canonicalName: row.canonicalName,
        matchedText: row.matchedText,
        similarityScore: cosineDistanceToSimilarity(row.cosineDistance),
      });
    }
  }
  return [...unique.values()].sort(compareSemanticCandidates);
}

function isSupportedType(value: unknown): value is RankedRow["entityType"] {
  return value === "BENEFICIARY" || value === "ASSET";
}
