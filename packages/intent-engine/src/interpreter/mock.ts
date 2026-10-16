import { IntentBundleDraftV1, IntentDraftV1, type IntentGoalConstraintV1, type IntentPreferenceV1 } from "@parlance/contracts";
import { ModelBackedIntentBundleInterpreter } from "../bundle/interpreter.js";
import { moneyEvidence, sourceActionClause, sourceActionSignals, sourceConditionalFundingCurrencies, sourceMinimumBalanceMoney } from "../validation/evidence.js";
import { ModelBackedIntentInterpreter } from "./interpreter.js";
import type { IntentModelClient, IntentModelInput } from "./types.js";

/** Bounded deterministic demo parser. No provider calls, identity inference, or canonical IDs. */
export class MockIntentModelClient implements IntentModelClient {
  async generateIntent(input: IntentModelInput): Promise<unknown> {
    const signals = sourceActionSignals(input.text);
    if (signals.length !== 1) throw new Error("MOCK_REQUEST_UNSUPPORTED");
    return draftForClause(sourceActionClause(input.text, signals, 0)!, input.text);
  }
}

export class MockIntentInterpreter extends ModelBackedIntentInterpreter {
  constructor() { super(new MockIntentModelClient()); }
}

/** Uses the same strict bundle boundary and independent coverage validation as TokenHub. */
export class MockIntentBundleInterpreter extends ModelBackedIntentBundleInterpreter {
  constructor() {
    super({ async generateIntentBundle({ text }) {
      const signals = sourceActionSignals(text);
      if (signals.length !== 2) throw new Error("MOCK_REQUEST_UNSUPPORTED");
      const items = signals.map((_signal, index) => {
        const clause = sourceActionClause(text, signals, index)!;
        const draft = draftForClause(clause, text);
        // Bundle schema requires money. A spoken-dollar placeholder is never a candidate:
        // coverage validation must produce the existing explicit SGD/USD clarification first.
        if (draft.goal.type === "DELIVER_MONEY" && draft.goal.amount?.currency === undefined) {
          if (!moneyEvidence(clause).some((item) => item.kind === "SPOKEN_DOLLARS" && item.currency === undefined)) throw new Error("MOCK_REQUEST_UNSUPPORTED");
          draft.goal.amount = { ...draft.goal.amount, currency: "USD" };
        }
        const complete = IntentDraftV1.parse({ ...draft, originalText: clause });
        return { goal: complete.goal, preferences: complete.preferences, itemId: `item-${index + 1}`, constraints: [] };
      });
      return IntentBundleDraftV1.parse({
        schemaVersion: "1", items, globalConstraints: constraints(text),
        explicitDependencies: /\bthen\b/iu.test(text) ? [{ beforeItemId: "item-1", afterItemId: "item-2", reason: "USER_EXPLICIT_ORDER" }] : [],
      });
    } });
  }
}

function constraints(text: string): IntentGoalConstraintV1[] {
  return sourceMinimumBalanceMoney(text).map((money) => ({ type: "MIN_AVAILABLE_BALANCE", money }));
}

function preferences(text: string): IntentPreferenceV1[] {
  return [...sourceConditionalFundingCurrencies(text)].map((currency) => ({ type: "PREFER_ACCOUNT", accountReference: currency }));
}

function draftForClause(clause: string, fullText: string) {
  const common = { schemaVersion: "1", constraints: constraints(fullText), preferences: preferences(fullText), references: [] };
  if (/^(?:send|deliver|remit|wire|transfer)\b/iu.test(clause)) {
    const recipientReference = /\bto\s+(.+?)(?=\s+(?:and|then|using|use|but|while|with|from|keeping)\b|[.!?,;]|$)/iu.exec(clause)?.[1]?.trim();
    const amountText = clause.slice(0, /\bto\b/iu.exec(clause)?.index ?? clause.length);
    const observed = moneyEvidence(amountText)[0];
    const numeric = /^(?:send|deliver|remit|wire|transfer)\s+(?:money\s+)?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?:\s|$)/iu.exec(amountText)?.[1];
    const amount: { currency?: string; minorUnits?: string } | undefined = observed !== undefined
      ? { minorUnits: observed.minorUnits, ...(observed.currency === undefined ? {} : { currency: observed.currency }) }
      : numeric === undefined ? undefined : { minorUnits: decimalMinorUnits(numeric) };
    return { ...common, goal: { type: "DELIVER_MONEY" as const, ...(amount === undefined ? {} : { amount }), ...(recipientReference === undefined ? {} : { recipientReference }) } };
  }
  const asset = /^(?:buy|purchase|acquire)\s+(one|[0-9]+(?:\.[0-9]+)?)\s+shares?\s+(?:of\s+)?(.+?)(?=\s+(?:and|then|using|use|but|while|with|keeping)\b|[!?,;]|\.(?:\s|$)|$)/iu.exec(clause);
  if (!asset) throw new Error("MOCK_REQUEST_UNSUPPORTED");
  return { ...common, goal: { type: "ACQUIRE_ASSET" as const, quantity: asset[1]!.toLowerCase() === "one" ? "1" : asset[1]!, assetReference: asset[2]!.replace(/\s+stock$/iu, "").trim() } };
}

function decimalMinorUnits(value: string): string {
  const [whole, fraction = ""] = value.replaceAll(",", "").split(".");
  return (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
}
