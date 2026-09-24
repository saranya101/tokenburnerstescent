import { expect, it } from "vitest";
import { DeterministicEntityGrounder } from "./grounder.js";
import { InMemoryEntityRepository } from "./repository.js";
import type { GroundingEntity } from "./types.js";

const entities: readonly GroundingEntity[] = [
  { entityType: "ACCOUNT", entityId: "acc_emergency", canonicalName: "Emergency Savings" },
  { entityType: "ACCOUNT", entityId: "acc_joint", canonicalName: "Joint Account", aliases: ["Joint", "Our Joint Account"] },
  { entityType: "ACCOUNT", entityId: "acc_john", canonicalName: "John Account", aliases: ["John"] },
  { entityType: "BENEFICIARY", entityId: "ben_ntu", canonicalName: "Nanyang Technological University", aliases: ["NTU"] },
  { entityType: "BENEFICIARY", entityId: "ben_john", canonicalName: "John Tan", aliases: ["John"] },
  { entityType: "ASSET", entityId: "asset_aapl", canonicalName: "Apple Inc.", aliases: ["Apple", "AAPL"] },
  { entityType: "OBLIGATION", entityId: "bill_sp", canonicalName: "SP Utilities", aliases: ["SP bill", "utilities"] },
];

function grounder(source = entities): DeterministicEntityGrounder {
  return new DeterministicEntityGrounder(new InMemoryEntityRepository(source));
}

it("resolves canonical names exactly, case-insensitively, and despite repeated whitespace", async () => {
  await expect(grounder().ground({ reference: "Emergency Savings", expectedEntityType: "ACCOUNT" })).resolves.toMatchObject({ status: "RESOLVED", entityId: "acc_emergency", resolutionMethod: "EXACT" });
  await expect(grounder().ground({ reference: "emergency savings" })).resolves.toMatchObject({ status: "RESOLVED", entityId: "acc_emergency", resolutionMethod: "EXACT" });
  await expect(grounder().ground({ reference: "  Emergency   Savings  " })).resolves.toMatchObject({ status: "RESOLVED", entityId: "acc_emergency", resolutionMethod: "EXACT", reference: "  Emergency   Savings  " });
});

it("resolves beneficiary and asset aliases", async () => {
  await expect(grounder().ground({ reference: "NTU" })).resolves.toMatchObject({ status: "RESOLVED", entityId: "ben_ntu", entityType: "BENEFICIARY", resolutionMethod: "ALIAS" });
  await expect(grounder().ground({ reference: "Apple" })).resolves.toMatchObject({ status: "RESOLVED", entityId: "asset_aapl", entityType: "ASSET", resolutionMethod: "ALIAS" });
});

it("filters candidates by expected entity type", async () => {
  await expect(grounder().ground({ reference: "John", expectedEntityType: "BENEFICIARY" })).resolves.toMatchObject({ status: "RESOLVED", entityId: "ben_john", resolutionMethod: "ALIAS" });
});

it("returns ambiguous rather than choosing across entity types", async () => {
  await expect(grounder().ground({ reference: "John" })).resolves.toEqual({
    status: "AMBIGUOUS", reference: "John", candidates: [
      { entityType: "ACCOUNT", entityId: "acc_john", canonicalName: "John Account" },
      { entityType: "BENEFICIARY", entityId: "ben_john", canonicalName: "John Tan" },
    ],
  });
});

it("preserves unknown references and never invents an ID", async () => {
  await expect(grounder().ground({ reference: "Unknown Recipient", expectedEntityType: "BENEFICIARY" })).resolves.toEqual({
    status: "NOT_FOUND", reference: "Unknown Recipient", expectedEntityType: "BENEFICIARY",
  });
});

it("prioritizes canonical names over aliases", async () => {
  const source = [...entities, { entityType: "ACCOUNT" as const, entityId: "acc_ntu", canonicalName: "NTU" }];
  await expect(grounder(source).ground({ reference: "NTU" })).resolves.toMatchObject({ status: "RESOLVED", entityId: "acc_ntu", resolutionMethod: "EXACT" });
});

it("is deterministic regardless of input entity order", async () => {
  const normal = await grounder().ground({ reference: "John" });
  const reversed = await grounder([...entities].reverse()).ground({ reference: "John" });
  expect(reversed).toEqual(normal);
});
