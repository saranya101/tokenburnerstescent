import { expect, it } from "vitest";
import { InMemorySemanticEntityRetriever } from "./in-memory.js";
import { semanticCandidateLimit } from "./ranking.js";

const retriever = new InMemorySemanticEntityRetriever(new Map([
  ["my university", [
    { entityId: "ben_nus", entityType: "BENEFICIARY", canonicalName: "National University of Singapore", matchedText: "university", similarityScore: 0.78 },
    { entityId: "ben_ntu", entityType: "BENEFICIARY", canonicalName: "Nanyang Technological University", matchedText: "university", similarityScore: 0.91 },
    { entityId: "acc_university", entityType: "ACCOUNT", canonicalName: "University Account", matchedText: "university", similarityScore: 0.91 },
  ]],
]));

it("ranks semantic candidates by score then deterministic entity tie-breakers", async () => {
  await expect(retriever.retrieve({ reference: "my university" })).resolves.toMatchObject([
    { entityId: "acc_university", similarityScore: 0.91 },
    { entityId: "ben_ntu", similarityScore: 0.91 },
    { entityId: "ben_nus", similarityScore: 0.78 },
  ]);
});

it("filters by expected entity type and enforces top-k limits", async () => {
  await expect(retriever.retrieve({ reference: "my university", expectedEntityType: "BENEFICIARY", limit: 1 })).resolves.toEqual([
    { entityId: "ben_ntu", entityType: "BENEFICIARY", canonicalName: "Nanyang Technological University", matchedText: "university", similarityScore: 0.91 },
  ]);
  expect(semanticCandidateLimit(0)).toBe(1);
  expect(semanticCandidateLimit(99)).toBe(10);
});
