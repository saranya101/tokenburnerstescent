import { ModelBackedIntentInterpreter } from "./interpreter.js";
import type { IntentModelClient, IntentModelInput } from "./types.js";

/** Local deterministic model stand-in. It still passes through the production validation boundary. */
export class MockIntentModelClient implements IntentModelClient {
  async generateIntent(input: IntentModelInput): Promise<unknown> {
    const amount = Number(input.text.match(/\d+(?:\.\d+)?/)?.[0] ?? 1);
    return {
      schemaVersion: "1",
      goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: String(Math.round(amount * 100)) }, recipientReference: "UNRESOLVED" },
      constraints: [], preferences: [], references: [{ reference: "UNRESOLVED", expectedEntityType: "BENEFICIARY" }],
    };
  }
}

export class MockIntentInterpreter extends ModelBackedIntentInterpreter {
  constructor() { super(new MockIntentModelClient()); }
}
