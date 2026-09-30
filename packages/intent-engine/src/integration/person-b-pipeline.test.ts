import { IntentDraftV1, type IntentDraftV1 as IntentDraft } from "@parlance/contracts";
import { expect, it, vi } from "vitest";
import {
  DeterministicEntityGrounder,
  DeterministicExplanationRenderer,
  DeterministicGoalContractBuilder,
  DeterministicIntentAmbiguityDetector,
  DbEntityRepository,
  InMemoryEntityRepository,
  IntentInterpreterError,
  groundingRequirementsForIntent,
  renderExplanationText,
  type EntityGrounder,
  type EntityGroundingResult,
  type GroundingRawQueryClient,
} from "../index.js";
import { ModelBackedIntentInterpreter } from "../interpreter/interpreter.js";
import {
  TokenHubIntentModelClient,
  type TokenHubTransport,
} from "../providers/tokenhub/client.js";

const detector = new DeterministicIntentAmbiguityDetector();
const builder = new DeterministicGoalContractBuilder();
const renderer = new DeterministicExplanationRenderer();

const metadata = {
  id: "goal-integration-1",
  userId: "user-a",
  version: 1,
  status: "AWAITING_GOAL_CONFIRMATION" as const,
  contractHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  createdAt: "2026-09-30T00:00:00Z",
  bindingConfirmed: false,
};

function intent(
  originalText: string,
  goal: IntentDraft["goal"],
  constraints: IntentDraft["constraints"] = [],
  preferences: IntentDraft["preferences"] = [],
  references: IntentDraft["references"] = [],
): IntentDraft {
  return IntentDraftV1.parse({ schemaVersion: "1", originalText, goal, constraints, preferences, references });
}

async function groundIntent(
  draft: IntentDraft,
  grounder: EntityGrounder,
  semanticSearch = false,
): Promise<readonly EntityGroundingResult[]> {
  return Promise.all(groundingRequirementsForIntent(draft).map((requirement) => grounder.ground({
    reference: requirement.reference,
    ...(requirement.expectedEntityType === undefined ? {} : { expectedEntityType: requirement.expectedEntityType }),
    ...(semanticSearch ? { semanticSearch: { limit: 5 } } : {}),
  })));
}

async function resolvedPipeline(draft: IntentDraft, grounder: EntityGrounder) {
  const groundingResults = await groundIntent(draft, grounder);
  const ambiguity = detector.analyze({ draft, groundingResults });
  expect(ambiguity).toEqual({ status: "CLEAR" });
  const contract = builder.build({ draft, groundingResults, metadata });
  const explanation = renderer.explain({ subject: "GOAL", goal: contract });
  return { groundingResults, contract, explanation };
}

it("runs DELIVER_MONEY from exact grounding through canonical contract and human explanation", async () => {
  const originalText = "Send Campus Bursary USD 25.00";
  const draft = intent(originalText, {
    type: "DELIVER_MONEY",
    amount: { currency: "USD", minorUnits: "2500" },
    recipientReference: "Campus Bursary",
  });
  const grounder = new DeterministicEntityGrounder(new InMemoryEntityRepository([{
    entityType: "BENEFICIARY",
    entityId: "ben-campus",
    canonicalName: "Campus Bursary",
  }]));

  const { groundingResults, contract, explanation } = await resolvedPipeline(draft, grounder);

  expect(draft.originalText).toBe(originalText);
  expect(groundingResults).toEqual([{
    status: "RESOLVED",
    reference: "Campus Bursary",
    entityType: "BENEFICIARY",
    entityId: "ben-campus",
    resolutionMethod: "EXACT",
  }]);
  expect(contract.goal).toMatchObject({ type: "DELIVER_MONEY", recipientId: "ben-campus" });
  expect(contract.entityBindings[0]?.reference).toBe("Campus Bursary");
  expect(renderExplanationText(explanation)).toContain("Deliver USD 25.00 to Campus Bursary.");
  expect(renderExplanationText(explanation)).not.toContain("ben-campus");
});

it("runs ACQUIRE_ASSET through alias grounding without elevating alias matching to model authority", async () => {
  const draft = intent("Acquire Bluebird for US$1,000", {
    type: "ACQUIRE_ASSET",
    assetReference: "Bluebird",
    budget: { currency: "USD", minorUnits: "100000" },
  });
  const grounder = new DeterministicEntityGrounder(new InMemoryEntityRepository([{
    entityType: "ASSET",
    entityId: "asset-bluebird",
    canonicalName: "Bluebird Fund",
    aliases: ["Bluebird"],
  }]));

  const { groundingResults, contract, explanation } = await resolvedPipeline(draft, grounder);

  expect(groundingResults[0]).toMatchObject({ status: "RESOLVED", resolutionMethod: "ALIAS" });
  expect(contract.goal).toEqual({
    type: "ACQUIRE_ASSET",
    assetId: "asset-bluebird",
    budget: { currency: "USD", minorUnits: "100000" },
  });
  expect(renderExplanationText(explanation)).toContain("Acquire Bluebird with a budget of USD 1,000.00.");
  expect(renderExplanationText(explanation)).not.toContain("asset-bluebird");
});

it("preserves and grounds an excluded-account hard constraint end to end", async () => {
  const draft = intent(
    "Send Alex S$40 and don't touch Emergency Savings",
    { type: "DELIVER_MONEY", amount: { currency: "SGD", minorUnits: "4000" }, recipientReference: "Alex" },
    [{ type: "EXCLUDED_ACCOUNT", accountReference: "Emergency Savings" }],
  );
  const grounder = new DeterministicEntityGrounder(new InMemoryEntityRepository([
    { entityType: "BENEFICIARY", entityId: "ben-alex", canonicalName: "Alex" },
    { entityType: "ACCOUNT", entityId: "acc-emergency", canonicalName: "Emergency Savings" },
  ]));

  const { contract, explanation } = await resolvedPipeline(draft, grounder);

  expect(contract.constraints).toEqual([{ type: "EXCLUDED_ACCOUNT", accountId: "acc-emergency" }]);
  expect(renderExplanationText(explanation)).toContain("Do not use Emergency Savings.");
  expect(renderExplanationText(explanation)).not.toContain("acc-emergency");
});

it("stops an ambiguous exact match before GoalContract construction", async () => {
  const draft = intent("Send Shared Recipient USD 5", {
    type: "DELIVER_MONEY",
    amount: { currency: "USD", minorUnits: "500" },
    recipientReference: "Shared Recipient",
  });
  const grounder = new DeterministicEntityGrounder(new InMemoryEntityRepository([
    { entityType: "BENEFICIARY", entityId: "ben-one", canonicalName: "Shared Recipient" },
    { entityType: "BENEFICIARY", entityId: "ben-two", canonicalName: "Shared  Recipient" },
  ]));
  const groundingResults = await groundIntent(draft, grounder);

  expect(groundingResults[0]?.status).toBe("AMBIGUOUS");
  expect(detector.analyze({ draft, groundingResults })).toMatchObject({
    status: "NEEDS_CLARIFICATION",
    clarifications: [{ reason: "AMBIGUOUS_ENTITY", originalReference: "Shared Recipient" }],
  });
  expect(() => builder.build({ draft, groundingResults, metadata })).toThrow(expect.objectContaining({
    code: "UNRESOLVED_REFERENCE",
  }));
});

it("keeps high-scoring semantic candidates as clarification-only results", async () => {
  const draft = intent("Send my old school USD 5", {
    type: "DELIVER_MONEY",
    amount: { currency: "USD", minorUnits: "500" },
    recipientReference: "my old school",
  });
  const semanticRetriever = {
    retrieve: vi.fn().mockResolvedValue([{
      entityId: "ben-school",
      entityType: "BENEFICIARY" as const,
      canonicalName: "Example University",
      matchedText: "university",
      similarityScore: 0.999,
    }]),
  };
  const grounder = new DeterministicEntityGrounder(new InMemoryEntityRepository([]), semanticRetriever);
  const groundingResults = await groundIntent(draft, grounder, true);

  expect(groundingResults[0]?.status).toBe("CANDIDATES");
  expect(detector.analyze({ draft, groundingResults })).toMatchObject({
    status: "NEEDS_CLARIFICATION",
    clarifications: [{ reason: "MULTIPLE_SEMANTIC_CANDIDATES" }],
  });
  expect(() => builder.build({ draft, groundingResults, metadata })).toThrow(expect.objectContaining({
    code: "UNRESOLVED_REFERENCE",
  }));
});

it("lets semantic fields override contradictory supplemental typing without mutating the draft", async () => {
  const draft = intent(
    "Send USD 7000.00 to Example University",
    {
      type: "DELIVER_MONEY",
      amount: { currency: "USD", minorUnits: "700000" },
      recipientReference: "Example University",
    },
    [],
    [],
    [{ reference: "  EXAMPLE   UNIVERSITY ", expectedEntityType: "ASSET" }],
  );
  const before = structuredClone(draft);
  const requirements = groundingRequirementsForIntent(draft);
  const grounder = new DeterministicEntityGrounder(new InMemoryEntityRepository([{
    entityType: "BENEFICIARY",
    entityId: "ben-university",
    canonicalName: "Example University",
  }]));

  const { contract } = await resolvedPipeline(draft, grounder);

  expect(requirements).toEqual([{
    field: "goal.recipientReference",
    reference: "Example University",
    expectedEntityType: "BENEFICIARY",
    source: "SEMANTIC_FIELD",
  }]);
  expect(contract.entityBindings).toEqual([expect.objectContaining({
    reference: "Example University",
    entityType: "BENEFICIARY",
    entityId: "ben-university",
  })]);
  expect(draft).toEqual(before);
});

it("rejects a model-authored canonical-looking reference before it becomes IntentDraftV1", async () => {
  const candidate = {
    schemaVersion: "1",
    goal: {
      selectedGoalType: "DELIVER_MONEY",
      goalSlots: {
        deliverMoney: {
          amount: { currency: "USD", minorUnits: "500" },
          recipientReference: "ben_alex",
        },
        acquireAsset: null,
        payBill: null,
        moveFunds: null,
      },
    },
    constraints: {
      maxTotalCost: null,
      minimumAvailableBalances: [],
      excludedAccounts: [],
      maxLockInDays: null,
    },
    preferences: {
      minimizeTotalCost: false,
      minimizeFx: false,
      fastest: false,
      preferredAccounts: [],
    },
    references: [{ reference: "ben_alex", expectedEntityType: "BENEFICIARY" }],
  };
  const transport: TokenHubTransport = {
    createCompletion: vi.fn().mockResolvedValue({ content: JSON.stringify(candidate) }),
  };
  const interpreter = new ModelBackedIntentInterpreter(new TokenHubIntentModelClient({
    apiKey: "synthetic-test-key",
    baseUrl: "https://example.test/v1",
    model: "hy3",
    thinking: "disabled",
  }, transport));

  await expect(interpreter.interpretUserRequest({
    text: "Send USD 5 to ben_alex",
    userId: "user-a",
  })).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" } satisfies Partial<IntentInterpreterError>);
});

it("fails closed for DB entity types without a safe canonical model", async () => {
  class NoQueryClient implements GroundingRawQueryClient {
    readonly query = vi.fn();
    async $queryRawUnsafe<T>(): Promise<T> {
      this.query();
      return [] as T;
    }
  }
  const client = new NoQueryClient();
  const draft = intent("Pay Example Utilities S$40", {
    type: "PAY_BILL",
    billerReference: "Example Utilities",
    amount: { currency: "SGD", minorUnits: "4000" },
  });
  const grounder = new DeterministicEntityGrounder(new DbEntityRepository(client, "user-a"));
  const groundingResults = await groundIntent(draft, grounder);

  expect(groundingResults).toEqual([{
    status: "NOT_FOUND",
    reference: "Example Utilities",
    expectedEntityType: "BILLER",
  }]);
  expect(client.query).not.toHaveBeenCalled();
  expect(detector.analyze({ draft, groundingResults })).toMatchObject({ status: "NEEDS_CLARIFICATION" });
  expect(() => builder.build({ draft, groundingResults, metadata })).toThrow(expect.objectContaining({
    code: "UNRESOLVED_REFERENCE",
  }));
});
