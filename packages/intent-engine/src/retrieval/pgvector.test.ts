import { expect, it } from "vitest";
import { createDbGroundingStack } from "../grounding/db-factory.js";
import type { GroundingRawQueryClient } from "../grounding/db-types.js";
import {
  cosineDistanceToSimilarity,
  ENTITY_ALIAS_EMBEDDING_DIMENSIONS,
  PgVectorSemanticEntityRetriever,
  type SemanticReferenceEmbedder,
} from "./pgvector.js";

class FakeRawQueryClient implements GroundingRawQueryClient {
  readonly calls: { query: string; values: readonly unknown[] }[] = [];

  constructor(private readonly results: unknown[][]) {}

  async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
    this.calls.push({ query, values });
    return (this.results.shift() ?? []) as T;
  }
}

const embedding = Array.from({ length: ENTITY_ALIAS_EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0);

class FakeEmbedder implements SemanticReferenceEmbedder {
  readonly references: string[] = [];
  constructor(private readonly result: readonly number[] = embedding) {}
  async embedReference(reference: string): Promise<readonly number[]> {
    this.references.push(reference);
    return this.result;
  }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    ownerUserId: "user-a",
    entityType: "BENEFICIARY",
    entityId: "ben-ntu",
    canonicalName: "Nanyang Technological University",
    matchedText: "NTU",
    cosineDistance: 0.01,
    ...overrides,
  };
}

it("queries pgvector with user scope, SQL type filtering, topK, and deterministic ordering", async () => {
  const client = new FakeRawQueryClient([[
    row({ entityId: "ben-z", canonicalName: "Zed", matchedText: "Zed alias", cosineDistance: 0.1 }),
    row({ entityId: "ben-a", canonicalName: "Alpha", matchedText: "Alpha alias", cosineDistance: 0.1 }),
    row({ ownerUserId: "user-b", entityId: "ben-other", cosineDistance: 0 }),
    row({ entityType: "ASSET", entityId: "asset-wrong", cosineDistance: 0 }),
  ]]);
  const embedder = new FakeEmbedder();
  const retriever = new PgVectorSemanticEntityRetriever(client, "user-a", embedder);
  await expect(retriever.retrieve({ reference: "my university", expectedEntityType: "BENEFICIARY", limit: 2 })).resolves.toEqual([
    { entityId: "ben-a", entityType: "BENEFICIARY", canonicalName: "Alpha", matchedText: "Alpha alias", similarityScore: 0.9 },
    { entityId: "ben-z", entityType: "BENEFICIARY", canonicalName: "Zed", matchedText: "Zed alias", similarityScore: 0.9 },
  ]);
  expect(embedder.references).toEqual(["my university"]);
  expect(client.calls[0]?.values[0]).toBe("user-a");
  expect(client.calls[0]?.values[1]).toBe(`[${embedding.join(",")}]`);
  expect(client.calls[0]?.values[2]).toBe(2);
  expect(client.calls[0]?.query).toContain("embedding <=> $2::vector");
  expect(client.calls[0]?.query).toContain('ea."userId" = $1');
  expect(client.calls[0]?.query).toContain('ea."entityType" = \'BENEFICIARY\'');
  expect(client.calls[0]?.query).not.toContain('FROM "Holding"');
  expect(client.calls[0]?.query).toContain('LIMIT $3');
});

it("projects canonical names and the closest matched alias once per entity", async () => {
  const client = new FakeRawQueryClient([[
    row({ matchedText: "university", cosineDistance: 0.2 }),
    row({ matchedText: "NTU", cosineDistance: 0.05 }),
  ]]);
  const retriever = new PgVectorSemanticEntityRetriever(client, "user-a", new FakeEmbedder());
  await expect(retriever.retrieve({ reference: "school" })).resolves.toEqual([
    {
      entityId: "ben-ntu",
      entityType: "BENEFICIARY",
      canonicalName: "Nanyang Technological University",
      matchedText: "NTU",
      similarityScore: 0.95,
    },
  ]);
});

it("converts cosine distance to a safely clamped 0..1 score", () => {
  expect(cosineDistanceToSimilarity(-0.2)).toBe(1);
  expect(cosineDistanceToSimilarity(0)).toBe(1);
  expect(cosineDistanceToSimilarity(0.25)).toBe(0.75);
  expect(cosineDistanceToSimilarity(1.4)).toBe(0);
  expect(cosineDistanceToSimilarity(Number.NaN)).toBe(0);
});

it("returns no unsupported entity type without embedding or querying", async () => {
  const client = new FakeRawQueryClient([]);
  const embedder = new FakeEmbedder();
  const retriever = new PgVectorSemanticEntityRetriever(client, "user-a", embedder);
  await expect(retriever.retrieve({ reference: "savings", expectedEntityType: "ACCOUNT" })).resolves.toEqual([]);
  expect(embedder.references).toEqual([]);
  expect(client.calls).toEqual([]);
});

it("rejects vectors that cannot match EntityAlias vector(1536)", async () => {
  const client = new FakeRawQueryClient([]);
  const retriever = new PgVectorSemanticEntityRetriever(client, "user-a", new FakeEmbedder([1, 2, 3]));
  await expect(retriever.retrieve({ reference: "school" })).rejects.toThrow("exactly 1536 finite dimensions");
  expect(client.calls).toEqual([]);
});

it("keeps a 0.99 semantic match as CANDIDATES rather than resolving it", async () => {
  const client = new FakeRawQueryClient([[], [], [row()]]);
  const { grounder } = createDbGroundingStack({ client, userId: "user-a", embedder: new FakeEmbedder() });
  await expect(grounder.ground({
    reference: "my university",
    expectedEntityType: "BENEFICIARY",
    semanticSearch: { limit: 5 },
  })).resolves.toEqual({
    status: "CANDIDATES",
    reference: "my university",
    expectedEntityType: "BENEFICIARY",
    candidates: [{
      entityId: "ben-ntu",
      entityType: "BENEFICIARY",
      canonicalName: "Nanyang Technological University",
      matchedText: "NTU",
      similarityScore: 0.99,
    }],
  });
  expect(client.calls).toHaveLength(3);
});
