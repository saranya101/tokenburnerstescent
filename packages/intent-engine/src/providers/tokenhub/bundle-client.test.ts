import { expect, it, vi } from "vitest";
import { ModelBackedIntentBundleInterpreter } from "../../bundle/interpreter.js";
import { INTENT_BUNDLE_V1_SYSTEM_PROMPT } from "../../prompts/intent-bundle-v1.js";
import { INTENT_BUNDLE_CANDIDATE_SCHEMA, TokenHubIntentBundleModelClient, type TokenHubBundleTransport } from "./bundle-client.js";

const sourceText = "Send John USD 300 and then buy one Apple share, but keep at least S$1,000 available.";
const transportCandidate = {
  schemaVersion: "1",
  items: [
    {
      itemId: "item-1",
      goal: {
        selectedGoalType: "DELIVER_MONEY",
        goalSlots: {
          deliverMoney: { amount: { currency: "USD", minorUnits: "30000" }, recipientReference: "John" },
          acquireAsset: { assetReference: "invented inactive slot", budget: null, quantity: "99" },
        },
      },
      constraints: { minimumAvailableBalances: [], excludedAccounts: [] },
      preferences: {},
    },
    {
      itemId: "item-2",
      goal: {
        selectedGoalType: "ACQUIRE_ASSET",
        goalSlots: {
          acquireAsset: { assetReference: "Apple", budget: null, quantity: "1" },
        },
      },
      constraints: { minimumAvailableBalances: [], excludedAccounts: [] },
      preferences: {},
    },
  ],
  globalConstraints: {
    minimumAvailableBalances: [{ money: { currency: "SGD", minorUnits: "100000" }, accountReference: null }],
  },
  explicitDependencies: [{ beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" }],
};

it("defines the headline ordering direction and minor-unit conversion explicitly", () => {
  expect(INTENT_BUNDLE_V1_SYSTEM_PROMPT).toContain("beforeItemId item-1, afterItemId item-2");
  expect(INTENT_BUNDLE_V1_SYSTEM_PROMPT).toContain('USD 300 is currency USD with minorUnits "30000"');
  expect(INTENT_BUNDLE_V1_SYSTEM_PROMPT).toContain('S$1,000 is currency SGD with minorUnits\n"100000"');
});

it("projects a sparse TokenHub bundle DTO into the frozen shared contract", async () => {
  const createCompletion = vi.fn().mockResolvedValue({ content: JSON.stringify(transportCandidate) });
  const transport: TokenHubBundleTransport = { createCompletion };
  const client = new TokenHubIntentBundleModelClient({
    apiKey: "synthetic-key", baseUrl: "https://example.test/v1", model: "hy3", thinking: "disabled",
  }, transport);
  const bundle = await new ModelBackedIntentBundleInterpreter(client).interpretUserRequest({ text: sourceText, userId: "private-user" });

  expect(bundle).toEqual({
    schemaVersion: "1",
    items: [
      { itemId: "item-1", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "30000" }, recipientReference: "John" }, constraints: [], preferences: [] },
      { itemId: "item-2", goal: { type: "ACQUIRE_ASSET", assetReference: "Apple", quantity: "1" }, constraints: [], preferences: [] },
    ],
    globalConstraints: [{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "100000" } }],
    explicitDependencies: [{ beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" }],
  });
  const request = createCompletion.mock.calls[0]?.[0];
  expect(request.response_format.json_schema.schema).toEqual(INTENT_BUNDLE_CANDIDATE_SCHEMA);
  expect(request.messages).toEqual(expect.arrayContaining([{ role: "user", content: sourceText }]));
  expect(JSON.stringify(request)).not.toContain("private-user");
});
