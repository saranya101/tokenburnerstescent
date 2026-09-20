import { IntentDraftV1, type IntentDraftV1 as IntentDraftType } from "@parlance/contracts";
import type { IntentInterpreter } from "../index.js";
export class MockIntentInterpreter implements IntentInterpreter {
  async interpretUserRequest(input: { text: string; userId: string }): Promise<IntentDraftType> {
    // Local-only fixture. A production adapter must validate untrusted model JSON identically.
    const amount = Number(input.text.match(/\d+(?:\.\d+)?/)?.[0] ?? 1);
    return IntentDraftV1.parse({
      schemaVersion: "1", originalText: input.text,
      goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: String(Math.round(amount * 100)) }, recipientReference: "UNRESOLVED" },
      constraints: [], preferences: [], references: [{ reference: "UNRESOLVED", expectedEntityType: "BENEFICIARY" }],
    });
  }
}
