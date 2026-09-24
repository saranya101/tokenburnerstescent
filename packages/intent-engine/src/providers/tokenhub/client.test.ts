import { expect, it, vi } from "vitest";
import { IntentDraftV1, type IntentDraftV1 as IntentDraft } from "@parlance/contracts";
import { INTENT_PROMPT_VERSION, INTENT_V1_SYSTEM_PROMPT } from "../../prompts/intent-v1.js";
import { INTENT_CANDIDATE_SCHEMA, TokenHubIntentModelClient, type TokenHubTransport } from "./client.js";
import { TokenHubConfigurationError, loadTokenHubConfig } from "./config.js";

const config = { apiKey: "test-tokenhub-key", baseUrl: "https://example.test/v1", model: "test-hy3" };
const input = { text: "Send NTU 5,000 USD", systemPrompt: INTENT_V1_SYSTEM_PROMPT, promptVersion: INTENT_PROMPT_VERSION };

function draftFor(goal: IntentDraft["goal"]) {
  return { schemaVersion: "1", originalText: "test input", goal, constraints: [], preferences: [], references: [] };
}

function goalSchema(type: string): { required: readonly string[]; properties: Record<string, unknown>; anyOf?: readonly { required: readonly string[] }[] } {
  const goal = INTENT_CANDIDATE_SCHEMA.properties.goal as unknown as { oneOf: { required: readonly string[]; properties: Record<string, unknown>; anyOf?: readonly { required: readonly string[] }[] }[] };
  const match = goal.oneOf.find((candidate) => (candidate.properties.type as { const?: string }).const === type);
  if (match === undefined) throw new Error(`Missing ${type} JSON-schema variant.`);
  return match;
}

function referenceEntityTypes(): readonly string[] {
  const references = INTENT_CANDIDATE_SCHEMA.properties.references as unknown as { items: { properties: { expectedEntityType: { enum: readonly string[] } } } };
  return references.items.properties.expectedEntityType.enum;
}

function transportReturning(content: string | null | undefined): TokenHubTransport {
  return { createCompletion: vi.fn().mockResolvedValue({ content }) };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
    throw new Error("Expected the provider call to fail.");
  } catch (error) {
    return error instanceof Error ? error : new Error("Non-error provider failure");
  }
}

it("uses configured model, the existing prompt, exact user input, and structured output", async () => {
  const transport = transportReturning('{"schemaVersion":"1"}');
  const client = new TokenHubIntentModelClient(config, transport);
  await expect(client.generateIntent(input)).resolves.toEqual({ schemaVersion: "1" });
  expect(transport.createCompletion).toHaveBeenCalledWith(expect.objectContaining({
    model: "test-hy3",
    messages: [
      { role: "system", content: INTENT_V1_SYSTEM_PROMPT },
      { role: "user", content: "Send NTU 5,000 USD" },
    ],
    temperature: 0,
    response_format: expect.objectContaining({ type: "json_schema" }),
  }));
});

it("matches DELIVER_MONEY's current IntentDraftV1 fields", () => {
  expect(goalSchema("DELIVER_MONEY").required).toEqual(["type", "amount", "recipientReference"]);
  expect(IntentDraftV1.safeParse(draftFor({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientReference: "NTU" })).success).toBe(true);
});

it("matches ACQUIRE_ASSET quantity-only, budget-only, and combined forms", () => {
  const schema = goalSchema("ACQUIRE_ASSET");
  expect(schema.required).toEqual(["type", "assetReference"]);
  expect(schema.anyOf).toEqual([{ required: ["quantity"] }, { required: ["budget"] }]);
  expect(IntentDraftV1.safeParse(draftFor({ type: "ACQUIRE_ASSET", assetReference: "Apple", quantity: "2" })).success).toBe(true);
  expect(IntentDraftV1.safeParse(draftFor({ type: "ACQUIRE_ASSET", assetReference: "Apple", budget: { currency: "USD", minorUnits: "10000" } })).success).toBe(true);
  expect(IntentDraftV1.safeParse(draftFor({ type: "ACQUIRE_ASSET", assetReference: "Apple", quantity: "2", budget: { currency: "USD", minorUnits: "10000" } })).success).toBe(true);
});

it("matches PAY_BILL's biller reference and MOVE_FUNDS reference fields", () => {
  expect(goalSchema("PAY_BILL").required).toEqual(["type", "billerReference"]);
  expect(goalSchema("MOVE_FUNDS").required).toEqual(["type", "amount", "destinationAccountReference"]);
  expect(IntentDraftV1.safeParse(draftFor({ type: "PAY_BILL", billerReference: "SP Utilities", amount: { currency: "SGD", minorUnits: "1000" } })).success).toBe(true);
  expect(IntentDraftV1.safeParse(draftFor({ type: "MOVE_FUNDS", amount: { currency: "SGD", minorUnits: "1000" }, sourceAccountReference: "Main", destinationAccountReference: "Savings" })).success).toBe(true);
  expect(referenceEntityTypes()).toContain("BILLER");
});

it("excludes obsolete maxSpend and obligationReference fields", () => {
  const acquire = goalSchema("ACQUIRE_ASSET");
  const bill = goalSchema("PAY_BILL");
  expect(acquire.properties).not.toHaveProperty("maxSpend");
  expect(bill.properties).not.toHaveProperty("obligationReference");
  expect(IntentDraftV1.safeParse({ ...draftFor({ type: "ACQUIRE_ASSET", assetReference: "Apple", quantity: "2" }), goal: { type: "ACQUIRE_ASSET", assetReference: "Apple", maxSpend: { currency: "USD", minorUnits: "100" } } }).success).toBe(false);
  expect(IntentDraftV1.safeParse({ ...draftFor({ type: "PAY_BILL", billerReference: "SP Utilities" }), goal: { type: "PAY_BILL", obligationReference: "SP Utilities" } }).success).toBe(false);
});

it.each([
  ["malformed JSON", "not JSON"],
  ["empty content", ""],
  ["null content", null],
])("handles %s without leaking the API key", async (_name, content) => {
  const error = await captureError(new TokenHubIntentModelClient(config, transportReturning(content)).generateIntent(input));
  expect(error.message).toContain("TokenHub");
  expect(error.message).not.toContain(config.apiKey);
});

it("sanitizes provider/network errors", async () => {
  const transport: TokenHubTransport = {
    createCompletion: vi.fn().mockRejectedValue(new Error("Authorization: Bearer test-tokenhub-key")),
  };
  const error = await captureError(new TokenHubIntentModelClient(config, transport).generateIntent(input));
  expect(error.message).toBe("TokenHub request failed.");
  expect(error.message).not.toContain(config.apiKey);
});

it("requires TOKENHUB_API_KEY and applies safe defaults", () => {
  expect(() => loadTokenHubConfig({})).toThrow(TokenHubConfigurationError);
  expect(loadTokenHubConfig({ TOKENHUB_API_KEY: "configured-key" })).toMatchObject({
    baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1",
    model: "hy3",
  });
});
