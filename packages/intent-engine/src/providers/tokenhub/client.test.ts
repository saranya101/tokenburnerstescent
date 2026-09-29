import { expect, it, vi } from "vitest";
import { IntentDraftV1, type IntentDraftV1 as IntentDraft } from "@parlance/contracts";
import { ModelBackedIntentInterpreter } from "../../interpreter/interpreter.js";
import { INTENT_PROMPT_VERSION, INTENT_V1_SYSTEM_PROMPT } from "../../prompts/intent-v1.js";
import { INTENT_CANDIDATE_SCHEMA, projectTokenHubTransportCandidate, TokenHubIntentModelClient, TokenHubProviderError, type TokenHubTransport } from "./client.js";
import { TokenHubConfigurationError, loadTokenHubConfig } from "./config.js";

const config = { apiKey: "test-tokenhub-key", baseUrl: "https://example.test/v1", model: "test-hy3" };
const input = { text: "Send NTU 5,000 USD", systemPrompt: INTENT_V1_SYSTEM_PROMPT, promptVersion: INTENT_PROMPT_VERSION };

function draftFor(goal: IntentDraft["goal"]) {
  return { schemaVersion: "1", originalText: "test input", goal, constraints: [], preferences: [], references: [] };
}

function goalSchema(): { additionalProperties: false; required: readonly string[]; properties: Record<string, unknown> } {
  return INTENT_CANDIDATE_SCHEMA.properties.goal as unknown as { additionalProperties: false; required: readonly string[]; properties: Record<string, unknown> };
}

function transportGoal(acquireOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selectedGoalType: "ACQUIRE_ASSET",
    goalSlots: {
      deliverMoney: null,
      acquireAsset: {
        assetReference: "XYZ",
        budget: { currency: "USD", minorUnits: "100000" },
        quantity: null,
        ...acquireOverrides,
      },
      payBill: null,
      moveFunds: null,
    },
    ...overrides,
  };
}

function goalSlotsSchema(): { additionalProperties: false; required: readonly string[]; properties: Record<string, unknown> } {
  const goalSlots = goalSchema().properties.goalSlots as { additionalProperties: false; required: readonly string[]; properties: Record<string, unknown> };
  return goalSlots;
}

function projectGoal(goal: unknown): unknown {
  return (projectTokenHubTransportCandidate({ goal }) as { goal: unknown }).goal;
}

function transportConstraints(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxTotalCost: null,
    minimumAvailableBalances: [],
    excludedAccounts: [],
    maxLockInDays: null,
    ...overrides,
  };
}

function transportPreferences(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { minimizeTotalCost: false, minimizeFx: false, fastest: false, preferredAccounts: [], ...overrides };
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
  expect(transport.createCompletion).toHaveBeenCalledWith(expect.not.objectContaining({ thinking: expect.anything() }));
});

it.each(["disabled", "enabled"] as const)("sends TokenHub thinking mode %s when configured", async (thinking) => {
  const transport = transportReturning('{"schemaVersion":"1"}');
  const client = new TokenHubIntentModelClient({ ...config, thinking }, transport);
  await client.generateIntent(input);
  expect(transport.createCompletion).toHaveBeenCalledWith(expect.objectContaining({ thinking: { type: thinking } }));
});

it("uses a strict selected type and isolated semantic goal slots at the provider boundary", () => {
  const schema = goalSchema();
  const slots = goalSlotsSchema();
  expect(schema.required).toEqual(["selectedGoalType", "goalSlots"]);
  expect((schema.properties.selectedGoalType as { enum: readonly string[] }).enum).toEqual([
    "DELIVER_MONEY", "ACQUIRE_ASSET", "PAY_BILL", "MOVE_FUNDS",
  ]);
  expect(schema.additionalProperties).toBe(false);
  expect(slots.required).toEqual(["deliverMoney", "acquireAsset", "payBill", "moveFunds"]);
  expect(slots.additionalProperties).toBe(false);
});

it("describes the type-specific goal field semantics for the provider", () => {
  const goalProperties = goalSchema().properties as Record<string, { description?: string }>;
  const slots = goalSlotsSchema().properties as Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
  expect(goalProperties.selectedGoalType?.description).toContain("ACQUIRE_ASSET means obtaining a named asset for a budget and/or quantity");
  expect(goalProperties.selectedGoalType?.description).toContain("DELIVER_MONEY means sending money to a recipient");
  expect(slots.acquireAsset?.description).toContain("never contains amount");
  expect(slots.acquireAsset?.properties?.assetReference?.description).toContain("Exact human phrase naming the asset");
  expect(slots.acquireAsset?.properties?.budget?.description).toContain("Money available to acquire the asset");
  expect(slots.deliverMoney?.properties?.recipientReference?.description).toContain("Exact human phrase identifying the recipient");
  expect(slots.payBill?.description).toContain("PAY_BILL");
  expect(slots.moveFunds?.description).toContain("MOVE_FUNDS");
});

it("requires all four goal slots and allows every unused variant to be null", () => {
  const selectedGoalType = goalSchema().properties.selectedGoalType as { type: string };
  const slots = goalSlotsSchema().properties as Record<string, { type?: readonly string[]; additionalProperties?: boolean; required?: readonly string[]; properties?: Record<string, unknown> }>;
  expect(selectedGoalType.type).toBe("string");
  for (const field of ["deliverMoney", "acquireAsset", "payBill", "moveFunds"]) {
    expect(slots[field]?.type).toEqual(["object", "null"]);
    expect(slots[field]?.additionalProperties).toBe(false);
  }
  expect(slots.acquireAsset?.properties).not.toHaveProperty("amount");
  expect(slots.deliverMoney?.properties).not.toHaveProperty("budget");
});

it("requires one semantic provider slot for every actual constraint and preference variant", () => {
  const constraints = INTENT_CANDIDATE_SCHEMA.properties.constraints as unknown as { required: readonly string[]; additionalProperties: boolean; properties: Record<string, { type?: string | readonly string[]; description?: string; required?: readonly string[]; additionalProperties?: boolean; properties?: Record<string, { type?: string; minimum?: number; minLength?: number; description?: string }> }> };
  const preferences = INTENT_CANDIDATE_SCHEMA.properties.preferences as unknown as { required: readonly string[]; additionalProperties: boolean; properties: Record<string, { type?: string | readonly string[]; description?: string }> };
  const references = INTENT_CANDIDATE_SCHEMA.properties.references as unknown as { items: { required: readonly string[]; additionalProperties: boolean; properties: Record<string, { type?: string | readonly string[] }> } };
  expect(constraints).toMatchObject({ required: ["maxTotalCost", "minimumAvailableBalances", "excludedAccounts", "maxLockInDays"], additionalProperties: false });
  expect(constraints.properties.maxTotalCost?.type).toEqual(["object", "null"]);
  expect(constraints.properties.minimumAvailableBalances?.type).toBe("array");
  expect(constraints.properties.excludedAccounts?.type).toBe("array");
  expect(constraints.properties.maxLockInDays?.type).toEqual(["object", "null"]);
  expect(constraints.properties.maxLockInDays?.required).toEqual(["days", "evidence"]);
  expect(constraints.properties.maxLockInDays?.additionalProperties).toBe(false);
  expect(constraints.properties.maxLockInDays?.properties?.days).toMatchObject({ type: "integer", minimum: 0 });
  expect(constraints.properties.maxLockInDays?.properties?.evidence).toMatchObject({ type: "string", minLength: 1 });
  expect(constraints.properties.maxTotalCost?.description).toContain("overall spending or cost ceiling");
  expect(constraints.properties.excludedAccounts?.description).toContain("not to use or touch");
  expect(constraints.properties.maxTotalCost?.description).toContain("explicitly stated");
  expect(constraints.properties.minimumAvailableBalances?.description).toContain("explicitly stated");
  expect(constraints.properties.excludedAccounts?.description).toContain("explicitly prohibited");
  expect(constraints.properties.maxLockInDays?.description).toContain("Null means no lock-in restriction was stated");
  expect(constraints.properties.maxLockInDays?.description).toContain("Zero days is valid only with verbatim evidence");
  expect(constraints.properties.maxLockInDays?.description).toContain("never use zero as a default");
  expect(constraints.properties.maxLockInDays?.properties?.evidence?.description).toContain("exact phrase copied verbatim");
  expect(preferences).toMatchObject({ required: ["minimizeTotalCost", "minimizeFx", "fastest", "preferredAccounts"], additionalProperties: false });
  expect(preferences.properties.minimizeTotalCost?.description).toContain("explicitly prefers");
  expect(preferences.properties.minimizeFx?.description).toContain("explicitly prefers");
  expect(preferences.properties.fastest?.description).toContain("explicitly prefers");
  expect(preferences.properties.preferredAccounts?.description).toContain("explicitly preferred");
  expect(references.items).toMatchObject({ required: ["reference", "expectedEntityType"], additionalProperties: false });
  expect(references.items.properties.expectedEntityType?.type).toEqual(["string", "null"]);
});

it("projects genuinely absent constraint and preference slots to empty canonical arrays", () => {
  expect(projectTokenHubTransportCandidate({ constraints: transportConstraints(), preferences: transportPreferences() }))
    .toEqual({ constraints: [], preferences: [] });
});

it("projects explicit preferences in deterministic canonical order", () => {
  expect(projectTokenHubTransportCandidate({
    preferences: transportPreferences({ minimizeTotalCost: true, minimizeFx: true, fastest: true, preferredAccounts: ["Main", "Reserve"] }),
  })).toEqual({
    preferences: [
      { type: "MINIMIZE_TOTAL_COST" },
      { type: "MINIMIZE_FX" },
      { type: "FASTEST" },
      { type: "PREFER_ACCOUNT", accountReference: "Main" },
      { type: "PREFER_ACCOUNT", accountReference: "Reserve" },
    ],
  });
});

it("projects every constraint slot in deterministic canonical order without changing values", () => {
  expect(projectTokenHubTransportCandidate({
    constraints: transportConstraints({
      maxTotalCost: { currency: "SGD", minorUnits: "690000" },
      minimumAvailableBalances: [{ money: { currency: "USD", minorUnits: "12345" }, accountReference: "Reserve Account" }],
      excludedAccounts: ["Rainy Day", "Holiday Fund"],
      maxLockInDays: { days: 30, evidence: "lock-in no more than 30 days" },
    }),
  }, "Keep Reserve Account funded with lock-in no more than 30 days")).toEqual({
    constraints: [
      { type: "MAX_TOTAL_COST", money: { currency: "SGD", minorUnits: "690000" } },
      { type: "MIN_AVAILABLE_BALANCE", money: { currency: "USD", minorUnits: "12345" }, accountReference: "Reserve Account" },
      { type: "EXCLUDED_ACCOUNT", accountReference: "Rainy Day" },
      { type: "EXCLUDED_ACCOUNT", accountReference: "Holiday Fund" },
      { type: "MAX_LOCK_IN_DAYS", days: 30 },
    ],
  });
});

it("preserves an explicitly emitted zero-day lock-in constraint", () => {
  expect(projectTokenHubTransportCandidate({
    constraints: transportConstraints({ maxLockInDays: { days: 0, evidence: "no lock-in" } }),
  }, "Acquire Example Deposit with no lock-in")).toEqual({ constraints: [{ type: "MAX_LOCK_IN_DAYS", days: 0 }] });
});

it.each([
  "Send USD 7000.00 to Nanyang Technological University",
  "Send Alex USD 10 from Main",
])("does not project an unstated lock-in constraint for unrelated transfer: %s", (originalText) => {
  expect(projectTokenHubTransportCandidate({ constraints: transportConstraints() }, originalText))
    .toEqual({ constraints: [] });
});

it("validates the exact unrelated transfer without MAX_LOCK_IN_DAYS", async () => {
  const originalText = "Send USD 7000.00 to Nanyang Technological University";
  const transportCandidate = {
    schemaVersion: "1",
    goal: {
      selectedGoalType: "DELIVER_MONEY",
      goalSlots: {
        deliverMoney: { amount: { currency: "USD", minorUnits: "700000" }, recipientReference: "Nanyang Technological University" },
        acquireAsset: null,
        payBill: null,
        moveFunds: null,
      },
    },
    constraints: transportConstraints(),
    preferences: transportPreferences(),
    references: [{ reference: "Nanyang Technological University", expectedEntityType: "BENEFICIARY" }],
  };
  const interpreter = new ModelBackedIntentInterpreter(
    new TokenHubIntentModelClient(config, transportReturning(JSON.stringify(transportCandidate))),
  );
  const draft = await interpreter.interpretUserRequest({ text: originalText, userId: "regression" });
  expect(draft.goal).toEqual({
    type: "DELIVER_MONEY",
    amount: { currency: "USD", minorUnits: "700000" },
    recipientReference: "Nanyang Technological University",
  });
  expect(draft.constraints).toEqual([]);
});

it("projects evidence-backed zero-day and thirty-day lock-in constraints exactly", () => {
  expect(projectTokenHubTransportCandidate({
    constraints: transportConstraints({ maxLockInDays: { days: 0, evidence: "zero-lock-in" } }),
  }, "Use only a zero-lock-in deposit")).toEqual({ constraints: [{ type: "MAX_LOCK_IN_DAYS", days: 0 }] });
  expect(projectTokenHubTransportCandidate({
    constraints: transportConstraints({ maxLockInDays: { days: 30, evidence: "lock-in no more than 30 days" } }),
  }, "Choose a deposit with lock-in no more than 30 days")).toEqual({ constraints: [{ type: "MAX_LOCK_IN_DAYS", days: 30 }] });
});

it.each([
  ["legacy numeric zero", 0, "Send USD 7000.00 to Nanyang Technological University"],
  ["missing evidence", { days: 0 }, "Use a deposit with no lock-in"],
  ["empty evidence", { days: 0, evidence: "" }, "Use a deposit with no lock-in"],
  ["unrelated evidence", { days: 0, evidence: "Send USD 7000.00" }, "Send USD 7000.00 to Nanyang Technological University"],
  ["evidence absent from original text", { days: 0, evidence: "no lock-in" }, "Send USD 7000.00 to Nanyang Technological University"],
] as const)("leaves %s unprojected for final IntentDraftV1 rejection", (_name, maxLockInDays, originalText) => {
  const projected = projectTokenHubTransportCandidate({
    constraints: transportConstraints({ maxLockInDays }),
  }, originalText) as { constraints: unknown };
  expect(Array.isArray(projected.constraints)).toBe(false);
  expect(IntentDraftV1.safeParse({
    schemaVersion: "1",
    originalText,
    goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientReference: "Nanyang Technological University" },
    constraints: projected.constraints,
    preferences: [],
    references: [{ reference: "Nanyang Technological University", expectedEntityType: "BENEFICIARY" }],
  }).success).toBe(false);
});

it("surfaces unsupported lock-in evidence as INVALID_MODEL_OUTPUT", async () => {
  const originalText = "Acquire Example Deposit with no timing restriction";
  const transportCandidate = {
    schemaVersion: "1",
    goal: transportGoal(),
    constraints: transportConstraints({ maxLockInDays: { days: 0, evidence: "no timing restriction" } }),
    preferences: transportPreferences(),
    references: [{ reference: "XYZ", expectedEntityType: "ASSET" }],
  };
  const interpreter = new ModelBackedIntentInterpreter(
    new TokenHubIntentModelClient(config, transportReturning(JSON.stringify(transportCandidate))),
  );
  await expect(interpreter.interpretUserRequest({ text: originalText, userId: "regression" }))
    .rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
});

it("does not infer constraints from originalText or audit references", () => {
  expect(projectTokenHubTransportCandidate({
    originalText: "Do not touch Rainy Day",
    constraints: transportConstraints(),
    preferences: transportPreferences(),
    references: [{ reference: "Rainy Day", expectedEntityType: "ACCOUNT" }],
  })).toEqual({
    originalText: "Do not touch Rainy Day",
    constraints: [],
    preferences: [],
    references: [{ reference: "Rainy Day", expectedEntityType: "ACCOUNT" }],
  });
});

it("preserves malformed constraint values for final IntentDraftV1 rejection", () => {
  const projected = projectTokenHubTransportCandidate({
    schemaVersion: "1",
    goal: transportGoal(),
    constraints: transportConstraints({ maxTotalCost: { currency: "SGD", minorUnits: 690000 } }),
    preferences: transportPreferences(),
    references: [],
  });
  expect(projected).toMatchObject({ constraints: [{ type: "MAX_TOTAL_COST", money: { currency: "SGD", minorUnits: 690000 } }] });
  expect(IntentDraftV1.safeParse({ ...(projected as object), originalText: "Acquire XYZ" }).success).toBe(false);
});

it("recursively removes only null-valued object fields while preserving arrays and values", () => {
  expect(projectTokenHubTransportCandidate({
    removed: null,
    nested: { removed: null, text: "unchanged", zero: 0, flag: false },
    array: [{ removed: null, kept: 1 }, null, "unchanged"],
  })).toEqual({
    nested: { text: "unchanged", zero: 0, flag: false },
    array: [{ kept: 1 }, null, "unchanged"],
  });
});

it("preserves non-null invalid semantics so IntentDraftV1 remains the business-rules authority", () => {
  const projectedGoal = projectGoal(transportGoal({
    amount: { currency: "USD", minorUnits: "100000" },
    assetReference: null,
    budget: null,
  }));
  expect(projectedGoal).toEqual({ type: "ACQUIRE_ASSET", amount: { currency: "USD", minorUnits: "100000" } });
  expect(IntentDraftV1.safeParse({ schemaVersion: "1", originalText: "Acquire XYZ", goal: projectedGoal, constraints: [], preferences: [], references: [] }).success).toBe(false);
});

it("does not invent missing required semantics during projection", () => {
  const projectedGoal = projectGoal(transportGoal({ budget: null, quantity: null }));
  expect(projectedGoal).toEqual({ type: "ACQUIRE_ASSET", assetReference: "XYZ" });
  expect(IntentDraftV1.safeParse({ schemaVersion: "1", originalText: "Acquire XYZ", goal: projectedGoal, constraints: [], preferences: [], references: [] }).success).toBe(false);
});

it("projects each valid semantic goal slot exactly", () => {
  const cases = [
    ["DELIVER_MONEY", "deliverMoney", { amount: { currency: "USD", minorUnits: "100000" }, recipientReference: "Alex" }, { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100000" }, recipientReference: "Alex" }],
    ["ACQUIRE_ASSET", "acquireAsset", { assetReference: "XYZ", budget: { currency: "USD", minorUnits: "100000" }, quantity: null }, { type: "ACQUIRE_ASSET", assetReference: "XYZ", budget: { currency: "USD", minorUnits: "100000" } }],
    ["PAY_BILL", "payBill", { billerReference: "Example Utility", amount: null }, { type: "PAY_BILL", billerReference: "Example Utility" }],
    ["MOVE_FUNDS", "moveFunds", { amount: { currency: "SGD", minorUnits: "5000" }, destinationAccountReference: "Reserve", sourceAccountReference: null }, { type: "MOVE_FUNDS", amount: { currency: "SGD", minorUnits: "5000" }, destinationAccountReference: "Reserve" }],
  ] as const;
  for (const [selectedGoalType, activeSlot, slotValue, expected] of cases) {
    const goalSlots = { deliverMoney: null, acquireAsset: null, payBill: null, moveFunds: null, [activeSlot]: slotValue };
    expect(projectGoal({ selectedGoalType, goalSlots })).toEqual(expected);
  }
});

it("rejects zero, multiple, and mismatched active goal slots instead of repairing them", () => {
  const zeroSlots = { selectedGoalType: "ACQUIRE_ASSET", goalSlots: { deliverMoney: null, acquireAsset: null, payBill: null, moveFunds: null } };
  const multipleSlots = transportGoal({}, {
    goalSlots: {
      deliverMoney: { amount: { currency: "USD", minorUnits: "100000" }, recipientReference: "Alex" },
      acquireAsset: { assetReference: "XYZ", budget: { currency: "USD", minorUnits: "100000" }, quantity: null },
      payBill: null,
      moveFunds: null,
    },
  });
  const mismatched = transportGoal({}, { selectedGoalType: "DELIVER_MONEY" });

  for (const goal of [zeroSlots, multipleSlots, mismatched]) {
    const projectedGoal = projectGoal(goal);
    expect(projectedGoal).not.toHaveProperty("type");
    expect(IntentDraftV1.safeParse({ schemaVersion: "1", originalText: "synthetic", goal: projectedGoal, constraints: [], preferences: [], references: [] }).success).toBe(false);
  }
});

it("projects a valid transport DTO without changing successful interpreter semantics", async () => {
  const transportCandidate = {
    schemaVersion: "1",
    goal: transportGoal(),
    constraints: transportConstraints(),
    preferences: transportPreferences(),
    references: [{ reference: "XYZ", expectedEntityType: null }],
  };
  const client = new TokenHubIntentModelClient(config, transportReturning(JSON.stringify(transportCandidate)));
  const projected = await client.generateIntent(input);
  expect(projected).toEqual({
    schemaVersion: "1",
    goal: { type: "ACQUIRE_ASSET", assetReference: "XYZ", budget: { currency: "USD", minorUnits: "100000" } },
    constraints: [], preferences: [], references: [{ reference: "XYZ" }],
  });
  expect(IntentDraftV1.safeParse({ ...(projected as object), originalText: input.text }).success).toBe(true);
});

it("instructs the model to preserve explicit restrictions and common currency notation", () => {
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("do not silently\ndiscard an explicit restriction");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("EXCLUDED_ACCOUNT constraint");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("MAX_TOTAL_COST constraint");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("US$ means USD and S$ means SGD");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("Never invent currency codes");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("restrictions, limits, exclusions, deadlines, and preferences");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("only when that\nsemantic category is genuinely absent");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("Hard constraints and preferences must be grounded in explicit user language");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("Do not invent a\nrestriction or preference merely to fill a slot");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("Numeric zero is a real user constraint, never a default");
});

it("distinguishes acquiring an asset for a budget from sending money to a recipient", () => {
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("not by the first verb alone");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain('"Get XYZ US$1,000"');
  expect(INTENT_V1_SYSTEM_PROMPT).toContain('ACQUIRE_ASSET with assetReference "XYZ" and a USD budget');
  expect(INTENT_V1_SYSTEM_PROMPT).toContain('"Send Alex US$1,000"');
  expect(INTENT_V1_SYSTEM_PROMPT).toContain('DELIVER_MONEY with recipientReference "Alex" and a USD amount');
});

it("distinguishes paying a biller from delivering money to a beneficiary", () => {
  const selectedGoalType = goalSchema().properties.selectedGoalType as { description?: string };
  const slots = goalSlotsSchema().properties as Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;

  expect(INTENT_V1_SYSTEM_PROMPT).toContain("PAY_BILL is for settling a bill, invoice, utility charge, merchant bill, or\nbiller obligation");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("reference is identified as a BILLER");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("DELIVER_MONEY is for sending or transferring money to a person");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain("Do not classify from a company name alone");
  expect(INTENT_V1_SYSTEM_PROMPT).toContain('"Pay Example Utilities S$40" means PAY_BILL');
  expect(INTENT_V1_SYSTEM_PROMPT).toContain('billerReference "Example Utilities" and an SGD amount');
  expect(INTENT_V1_SYSTEM_PROMPT).toContain('"Send Alex S$40" means DELIVER_MONEY');
  expect(INTENT_V1_SYSTEM_PROMPT).toContain('recipientReference "Alex" and an SGD amount');

  expect(selectedGoalType.description).toContain("settling a bill, invoice, utility charge, merchant bill, or biller obligation");
  expect(selectedGoalType.description).toContain("person, recipient, or beneficiary rather than settling a bill");
  expect(slots.payBill?.description).toContain("pay <biller/company/service> <amount>");
  expect(slots.payBill?.properties?.billerReference?.description).toContain("A BILLER reference being paid normally belongs here");
  expect(slots.deliverMoney?.description).toContain("person, recipient, or beneficiary rather than settling a bill");
  expect(slots.deliverMoney?.properties?.recipientReference?.description).toContain("Do not use this field for a biller being paid");
});

it("does not permit an empty goal under its intended provider structure", () => {
  const schema = goalSchema();
  expect(schema.required).toEqual(["selectedGoalType", "goalSlots"]);
  expect(schema.properties.selectedGoalType).toMatchObject({ enum: ["DELIVER_MONEY", "ACQUIRE_ASSET", "PAY_BILL", "MOVE_FUNDS"] });
});

it("keeps successful DELIVER_MONEY interpreter candidates valid", () => {
  expect(IntentDraftV1.safeParse(draftFor({ type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientReference: "NTU" })).success).toBe(true);
});

it("keeps ACQUIRE_ASSET quantity-only, budget-only, and combined forms valid", () => {
  expect(IntentDraftV1.safeParse(draftFor({ type: "ACQUIRE_ASSET", assetReference: "Apple", quantity: "2" })).success).toBe(true);
  expect(IntentDraftV1.safeParse(draftFor({ type: "ACQUIRE_ASSET", assetReference: "Apple", budget: { currency: "USD", minorUnits: "10000" } })).success).toBe(true);
  expect(IntentDraftV1.safeParse(draftFor({ type: "ACQUIRE_ASSET", assetReference: "Apple", quantity: "2", budget: { currency: "USD", minorUnits: "10000" } })).success).toBe(true);
});

it("matches PAY_BILL's biller reference and MOVE_FUNDS reference fields", () => {
  expect(IntentDraftV1.safeParse(draftFor({ type: "PAY_BILL", billerReference: "SP Utilities", amount: { currency: "SGD", minorUnits: "1000" } })).success).toBe(true);
  expect(IntentDraftV1.safeParse(draftFor({ type: "MOVE_FUNDS", amount: { currency: "SGD", minorUnits: "1000" }, sourceAccountReference: "Main", destinationAccountReference: "Savings" })).success).toBe(true);
  expect(referenceEntityTypes()).toContain("BILLER");
});

it("excludes obsolete maxSpend and obligationReference fields", () => {
  const slots = goalSlotsSchema().properties as Record<string, { properties?: Record<string, unknown> }>;
  expect(slots.acquireAsset?.properties).not.toHaveProperty("maxSpend");
  expect(slots.payBill?.properties).not.toHaveProperty("obligationReference");
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

it("preserves a redacted provider diagnostic for development-only smoke output", async () => {
  const providerFailure = Object.assign(new Error("Provider echoed test-tokenhub-key; Authorization: Bearer test-tokenhub-key"), {
    status: 400, code: "invalid_json_schema", type: "invalid_request_error", request_id: "request-123",
  });
  const transport: TokenHubTransport = { createCompletion: vi.fn().mockRejectedValue(providerFailure) };
  const error = await captureError(new TokenHubIntentModelClient(config, transport).generateIntent(input));
  expect(error).toBeInstanceOf(TokenHubProviderError);
  expect((error as TokenHubProviderError).diagnostic).toEqual({
    status: 400, code: "invalid_json_schema", type: "invalid_request_error", message: "Provider echoed [REDACTED]; Authorization: [REDACTED]", requestId: "request-123",
  });
  expect(JSON.stringify((error as TokenHubProviderError).diagnostic)).not.toContain(config.apiKey);
});

it("requires TOKENHUB_API_KEY and applies safe defaults", () => {
  expect(() => loadTokenHubConfig({})).toThrow(TokenHubConfigurationError);
  expect(loadTokenHubConfig({ TOKENHUB_API_KEY: "configured-key" })).toMatchObject({
    baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1",
    model: "hy3",
  });
  expect(loadTokenHubConfig({ TOKENHUB_API_KEY: "configured-key" })).not.toHaveProperty("thinking");
  expect(loadTokenHubConfig({ TOKENHUB_API_KEY: "configured-key", TOKENHUB_THINKING: "disabled" })).toMatchObject({ thinking: "disabled" });
  expect(loadTokenHubConfig({ TOKENHUB_API_KEY: "configured-key", TOKENHUB_THINKING: "enabled" })).toMatchObject({ thinking: "enabled" });
});

it.each(["", "DISABLED", "auto", "false"])("rejects invalid TOKENHUB_THINKING value %j", (thinking) => {
  expect(() => loadTokenHubConfig({ TOKENHUB_API_KEY: "configured-key", TOKENHUB_THINKING: thinking }))
    .toThrow(new TokenHubConfigurationError('TOKENHUB_THINKING must be either "disabled" or "enabled" when set.'));
});
