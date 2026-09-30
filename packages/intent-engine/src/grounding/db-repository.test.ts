import { expect, it } from "vitest";
import { DeterministicEntityGrounder } from "./grounder.js";
import { DbEntityRepository } from "./db-repository.js";
import type { GroundingRawQueryClient } from "./db-types.js";

class FakeRawQueryClient implements GroundingRawQueryClient {
  readonly calls: { query: string; values: readonly unknown[] }[] = [];

  constructor(private readonly results: unknown[][]) {}

  async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
    this.calls.push({ query, values });
    return (this.results.shift() ?? []) as T;
  }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    ownerUserId: "user-a",
    entityType: "BENEFICIARY",
    entityId: "ben-ntu",
    canonicalName: "Nanyang Technological University",
    ...overrides,
  };
}

it("matches canonical names with the existing normalization and preserves ambiguity", async () => {
  const client = new FakeRawQueryClient([[
    row(),
    row({ entityId: "ben-ntu-foundation", canonicalName: "Nanyang   Technological University" }),
  ]]);
  const grounder = new DeterministicEntityGrounder(new DbEntityRepository(client, "user-a"));
  await expect(grounder.ground({ reference: "  NANYANG technological university ", expectedEntityType: "BENEFICIARY" }))
    .resolves.toEqual({
      status: "AMBIGUOUS",
      reference: "  NANYANG technological university ",
      expectedEntityType: "BENEFICIARY",
      candidates: [
        { entityType: "BENEFICIARY", entityId: "ben-ntu", canonicalName: "Nanyang Technological University" },
        { entityType: "BENEFICIARY", entityId: "ben-ntu-foundation", canonicalName: "Nanyang   Technological University" },
      ],
    });
  expect(client.calls[0]?.values).toEqual(["user-a"]);
  expect(client.calls[0]?.query).toContain('b."userId" = $1');
  expect(client.calls[0]?.query).not.toContain('FROM "EntityAlias"');
});

it("matches aliases deterministically after an exact miss", async () => {
  const client = new FakeRawQueryClient([[], [row({ matchedAlias: "  NTU  " })]]);
  const grounder = new DeterministicEntityGrounder(new DbEntityRepository(client, "user-a"));
  await expect(grounder.ground({ reference: "ntu", expectedEntityType: "BENEFICIARY" })).resolves.toEqual({
    status: "RESOLVED",
    reference: "ntu",
    entityType: "BENEFICIARY",
    entityId: "ben-ntu",
    resolutionMethod: "ALIAS",
  });
  expect(client.calls[1]?.query).toContain('ea."entityType" = \'BENEFICIARY\'');
  expect(client.calls[1]?.query).toContain('b."userId" = ea."userId"');
});

it("preserves ambiguity when one alias names multiple user-owned entities", async () => {
  const client = new FakeRawQueryClient([[], [
    row({ entityId: "ben-one", canonicalName: "University One", matchedAlias: "university" }),
    row({ entityId: "ben-two", canonicalName: "University Two", matchedAlias: "university" }),
  ]]);
  const grounder = new DeterministicEntityGrounder(new DbEntityRepository(client, "user-a"));
  await expect(grounder.ground({ reference: "University", expectedEntityType: "BENEFICIARY" })).resolves.toMatchObject({
    status: "AMBIGUOUS",
    candidates: [
      { entityId: "ben-one", canonicalName: "University One" },
      { entityId: "ben-two", canonicalName: "University Two" },
    ],
  });
});

it("enforces user isolation and expected type defensively", async () => {
  const client = new FakeRawQueryClient([[
    row({ ownerUserId: "user-b", entityId: "ben-other" }),
    row(),
    row({ entityType: "ASSET", entityId: "asset-wrong", canonicalName: "Nanyang Technological University" }),
  ]]);
  const repository = new DbEntityRepository(client, "user-a");
  await expect(repository.findByCanonicalName("nanyang technological university", "BENEFICIARY")).resolves.toEqual([
    { entityType: "BENEFICIARY", entityId: "ben-ntu", canonicalName: "Nanyang Technological University" },
  ]);
  expect(client.calls[0]?.query).not.toContain('FROM "Holding"');
});

it("scopes assets through Holding and projects Asset.name as canonicalName", async () => {
  const client = new FakeRawQueryClient([[
    row({ entityType: "ASSET", entityId: "asset-aapl", canonicalName: "Apple Inc." }),
  ]]);
  const repository = new DbEntityRepository(client, "user-a");
  await expect(repository.findByCanonicalName("apple inc.", "ASSET")).resolves.toEqual([
    { entityType: "ASSET", entityId: "asset-aapl", canonicalName: "Apple Inc." },
  ]);
  expect(client.calls[0]?.query).toContain('FROM "Holding" h');
  expect(client.calls[0]?.query).toContain('h."userId" = $1');
  expect(client.calls[0]?.query).not.toContain('FROM "Beneficiary"');
});

it.each(["ACCOUNT", "BILLER", "OBLIGATION"] as const)("returns no %s match because the schema lacks a safe canonical display source", async (entityType) => {
  const client = new FakeRawQueryClient([]);
  const repository = new DbEntityRepository(client, "user-a");
  await expect(repository.findByCanonicalName("anything", entityType)).resolves.toEqual([]);
  await expect(repository.findByAlias("anything", entityType)).resolves.toEqual([]);
  expect(client.calls).toEqual([]);
});
