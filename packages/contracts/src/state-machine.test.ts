import { describe, expect, it } from "vitest";
import { assertGoalTransition } from "./state-machine.js";
import { IntentDraftV1 } from "./index.js";
describe("goal state machine", () => {
  it("allows confirmation flow", () => expect(() => assertGoalTransition("AWAITING_GOAL_CONFIRMATION", "CONFIRMED")).not.toThrow());
  it("rejects impossible jumps", () => expect(() => assertGoalTransition("DRAFT", "COMPLETED")).toThrow(/Invalid goal transition/));
  it("rejects action smuggling in intent output", () => expect(() => IntentDraftV1.parse({ schemaVersion: "1", originalText: "send money", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "100" }, recipientReference: "b" }, constraints: [], preferences: [], references: [], actions: [{ type: "TRANSFER" }] })).toThrow());
});
