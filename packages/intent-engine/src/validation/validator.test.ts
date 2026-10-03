import { describe, expect, it } from "vitest";
import { GoalContractCandidateV1, type GoalContractCandidate } from "../goal-contract/types.js";
import { DeterministicReadOnlyIntentValidator } from "./validator.js";

const validator = new DeterministicReadOnlyIntentValidator();

function candidate(value: Omit<GoalContractCandidate, "schemaVersion">): GoalContractCandidate {
  return GoalContractCandidateV1.parse({ schemaVersion: "1", ...value });
}

function codes(result: ReturnType<DeterministicReadOnlyIntentValidator["validate"]>): string[] {
  return result.mismatches.map(({ code }) => code);
}

describe("independent read-only intent validation", () => {
  it("passes the exact NTU transfer with the semantic beneficiary role authoritative", () => {
    const sourceText = "Send USD 7000.00 to Nanyang Technological University";
    const draft = {
      schemaVersion: "1", originalText: sourceText,
      goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientReference: "Nanyang Technological University" },
      constraints: [], preferences: [],
      references: [{ reference: "Nanyang Technological University", expectedEntityType: "ASSET" }],
    };
    const goalCandidate = candidate({
      goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientId: "ben-ntu" },
      constraints: [], preferences: [],
      entityBindings: [{ schemaVersion: "1", reference: "Nanyang Technological University", entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "EXACT", confirmed: false }],
    });

    expect(validator.validate({ sourceText, draft, candidate: goalCandidate })).toEqual({ status: "PASS", mismatches: [] });
  });

  it("fails when the NTU transfer is reinterpreted as an asset acquisition", () => {
    const sourceText = "Send USD 7000.00 to Nanyang Technological University";
    const draft = {
      schemaVersion: "1", originalText: sourceText,
      goal: { type: "ACQUIRE_ASSET", assetReference: "Nanyang Technological University", budget: { currency: "USD", minorUnits: "700000" } },
      constraints: [], preferences: [], references: [{ reference: "Nanyang Technological University", expectedEntityType: "ASSET" }],
    };
    const goalCandidate = candidate({
      goal: { type: "ACQUIRE_ASSET", assetId: "asset-ntu", budget: { currency: "USD", minorUnits: "700000" } },
      constraints: [], preferences: [],
      entityBindings: [{ schemaVersion: "1", reference: "Nanyang Technological University", entityType: "ASSET", entityId: "asset-ntu", resolutionMethod: "EXACT", confirmed: false }],
    });

    const result = validator.validate({ sourceText, draft, candidate: goalCandidate });
    expect(result.status).toBe("FAIL");
    expect(codes(result)).toContain("GOAL_TYPE_NOT_SUPPORTED_BY_SOURCE");
  });

  it("rejects invented lock-in and detects an omitted explicit lock-in limit", () => {
    const sourceWithoutLockIn = "Acquire Aurora Note for US$500.";
    const inventedDraft = {
      schemaVersion: "1", originalText: sourceWithoutLockIn,
      goal: { type: "ACQUIRE_ASSET", assetReference: "Aurora Note", budget: { currency: "USD", minorUnits: "50000" } },
      constraints: [{ type: "MAX_LOCK_IN_DAYS", days: 0 }], preferences: [], references: [],
    };
    const inventedCandidate = candidate({
      goal: { type: "ACQUIRE_ASSET", assetId: "asset-aurora", budget: { currency: "USD", minorUnits: "50000" } },
      constraints: [{ type: "MAX_LOCK_IN_DAYS", days: 0 }], preferences: [],
      entityBindings: [{ schemaVersion: "1", reference: "Aurora Note", entityType: "ASSET", entityId: "asset-aurora", resolutionMethod: "EXACT", confirmed: false }],
    });
    expect(codes(validator.validate({ sourceText: sourceWithoutLockIn, draft: inventedDraft, candidate: inventedCandidate }))).toContain("CONSTRAINT_NOT_SUPPORTED_BY_SOURCE");

    const sourceWithLockIn = "Acquire Example Deposit with a S$1,000 budget and no more than 30 lock-in days.";
    const omittedDraft = {
      schemaVersion: "1", originalText: sourceWithLockIn,
      goal: { type: "ACQUIRE_ASSET", assetReference: "Example Deposit", budget: { currency: "SGD", minorUnits: "100000" } },
      constraints: [], preferences: [], references: [],
    };
    const omittedCandidate = candidate({
      goal: { type: "ACQUIRE_ASSET", assetId: "asset-deposit", budget: { currency: "SGD", minorUnits: "100000" } },
      constraints: [], preferences: [],
      entityBindings: [{ schemaVersion: "1", reference: "Example Deposit", entityType: "ASSET", entityId: "asset-deposit", resolutionMethod: "EXACT", confirmed: false }],
    });
    const result = validator.validate({ sourceText: sourceWithLockIn, draft: omittedDraft, candidate: omittedCandidate });
    expect(result.mismatches).toContainEqual(expect.objectContaining({ code: "OMITTED_EXPLICIT_CONSTRAINT", expected: "MAX_LOCK_IN_DAYS" }));
  });

  it("rejects the prior canonical-ID grounding bypass even when the identifier appears in source text", () => {
    const sourceText = "Send USD 5 to ben_alex";
    const draft = {
      schemaVersion: "1", originalText: sourceText,
      goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500" }, recipientReference: "ben_alex" },
      constraints: [], preferences: [], references: [{ reference: "ben_alex", expectedEntityType: "BENEFICIARY" }],
    };
    const goalCandidate = candidate({
      goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500" }, recipientId: "ben_alex" },
      constraints: [], preferences: [],
      entityBindings: [{ schemaVersion: "1", reference: "ben_alex", entityType: "BENEFICIARY", entityId: "ben_alex", resolutionMethod: "EXACT", confirmed: false }],
    });

    const result = validator.validate({ sourceText, draft, candidate: goalCandidate });
    expect(result.status).toBe("FAIL");
    expect(codes(result)).toContain("CANONICAL_IDENTIFIER_REFERENCE");
  });

  it("checks biller, source/destination accounts, hard constraints, and explicit preferences", () => {
    const billText = "Pay Example Power S$85.40.";
    const bill = validator.validate({
      sourceText: billText,
      draft: {
        schemaVersion: "1", originalText: billText,
        goal: { type: "PAY_BILL", billerReference: "Example Power", amount: { currency: "SGD", minorUnits: "8540" } },
        constraints: [], preferences: [], references: [],
      },
      candidate: candidate({
        goal: { type: "PAY_BILL", billerId: "biller-power", amount: { currency: "SGD", minorUnits: "8540" } }, constraints: [], preferences: [],
        entityBindings: [{ schemaVersion: "1", reference: "Example Power", entityType: "BILLER", entityId: "biller-power", resolutionMethod: "EXACT", confirmed: false }],
      }),
    });
    expect(bill.status).toBe("PASS");

    const moveText = "Move S$100 from Daily Spending to Rainy Day, keep at least S$500 available in Main, don't touch Emergency Savings, prefer Daily Spending, and do it as fast as possible.";
    const move = validator.validate({
      sourceText: moveText,
      draft: {
        schemaVersion: "1", originalText: moveText,
        goal: { type: "MOVE_FUNDS", amount: { currency: "SGD", minorUnits: "10000" }, sourceAccountReference: "Daily Spending", destinationAccountReference: "Rainy Day" },
        constraints: [
          { type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "50000" }, accountReference: "Main" },
          { type: "EXCLUDED_ACCOUNT", accountReference: "Emergency Savings" },
        ],
        preferences: [{ type: "PREFER_ACCOUNT", accountReference: "Daily Spending" }, { type: "FASTEST" }], references: [],
      },
      candidate: candidate({
        goal: { type: "MOVE_FUNDS", amount: { currency: "SGD", minorUnits: "10000" }, sourceAccountId: "acc-daily", destinationAccountId: "acc-rainy" },
        constraints: [
          { type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "50000" }, accountId: "acc-main" },
          { type: "EXCLUDED_ACCOUNT", accountId: "acc-emergency" },
        ],
        preferences: [{ type: "PREFER_ACCOUNT", accountId: "acc-daily" }, { type: "FASTEST" }],
        entityBindings: [
          { schemaVersion: "1", reference: "Daily Spending", entityType: "ACCOUNT", entityId: "acc-daily", resolutionMethod: "EXACT", confirmed: false },
          { schemaVersion: "1", reference: "Rainy Day", entityType: "ACCOUNT", entityId: "acc-rainy", resolutionMethod: "EXACT", confirmed: false },
          { schemaVersion: "1", reference: "Main", entityType: "ACCOUNT", entityId: "acc-main", resolutionMethod: "EXACT", confirmed: false },
          { schemaVersion: "1", reference: "Emergency Savings", entityType: "ACCOUNT", entityId: "acc-emergency", resolutionMethod: "EXACT", confirmed: false },
        ],
      }),
    });
    expect(move).toEqual({ status: "PASS", mismatches: [] });
  });

  it("passes an asset budget with a cost cap, zero lock-in, and cost/FX preferences", () => {
    const sourceText = "Acquire Aurora Note with a US$500 budget, spend no more than US$550 total, require no lock-in, minimize total cost, and avoid FX.";
    const result = validator.validate({
      sourceText,
      draft: {
        schemaVersion: "1", originalText: sourceText,
        goal: { type: "ACQUIRE_ASSET", assetReference: "Aurora Note", budget: { currency: "USD", minorUnits: "50000" } },
        constraints: [
          { type: "MAX_TOTAL_COST", money: { currency: "USD", minorUnits: "55000" } },
          { type: "MAX_LOCK_IN_DAYS", days: 0 },
        ],
        preferences: [{ type: "MINIMIZE_TOTAL_COST" }, { type: "MINIMIZE_FX" }], references: [],
      },
      candidate: candidate({
        goal: { type: "ACQUIRE_ASSET", assetId: "asset-aurora", budget: { currency: "USD", minorUnits: "50000" } },
        constraints: [
          { type: "MAX_TOTAL_COST", money: { currency: "USD", minorUnits: "55000" } },
          { type: "MAX_LOCK_IN_DAYS", days: 0 },
        ],
        preferences: [{ type: "MINIMIZE_TOTAL_COST" }, { type: "MINIMIZE_FX" }],
        entityBindings: [{ schemaVersion: "1", reference: "Aurora Note", entityType: "ASSET", entityId: "asset-aurora", resolutionMethod: "EXACT", confirmed: false }],
      }),
    });

    expect(result).toEqual({ status: "PASS", mismatches: [] });
  });

  it("does not reuse the goal amount as evidence for a different cost cap", () => {
    const sourceText = "Acquire Aurora Note with a US$500 budget and spend no more than US$550 total.";
    const result = validator.validate({
      sourceText,
      draft: {
        schemaVersion: "1", originalText: sourceText,
        goal: { type: "ACQUIRE_ASSET", assetReference: "Aurora Note", budget: { currency: "USD", minorUnits: "50000" } },
        constraints: [{ type: "MAX_TOTAL_COST", money: { currency: "USD", minorUnits: "50000" } }], preferences: [], references: [],
      },
      candidate: candidate({
        goal: { type: "ACQUIRE_ASSET", assetId: "asset-aurora", budget: { currency: "USD", minorUnits: "50000" } },
        constraints: [{ type: "MAX_TOTAL_COST", money: { currency: "USD", minorUnits: "50000" } }], preferences: [],
        entityBindings: [{ schemaVersion: "1", reference: "Aurora Note", entityType: "ASSET", entityId: "asset-aurora", resolutionMethod: "EXACT", confirmed: false }],
      }),
    });

    expect(codes(result)).toContain("CONSTRAINT_NOT_SUPPORTED_BY_SOURCE");
  });

  it("fails on wrong amounts, missing references, wrong bindings, and omitted preferences", () => {
    const sourceText = "Send Alex US$100 as fast as possible.";
    const draft = {
      schemaVersion: "1", originalText: sourceText,
      goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "9000" }, recipientReference: "Morgan" },
      constraints: [], preferences: [], references: [],
    };
    const goalCandidate = candidate({
      goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "9001" }, recipientId: "ben-morgan" },
      constraints: [], preferences: [],
      entityBindings: [{ schemaVersion: "1", reference: "Morgan", entityType: "BENEFICIARY", entityId: "ben-other", resolutionMethod: "EXACT", confirmed: false }],
    });
    const result = validator.validate({ sourceText, draft, candidate: goalCandidate });
    expect(codes(result)).toEqual(expect.arrayContaining([
      "MONEY_MISMATCH", "MONEY_NOT_SUPPORTED_BY_SOURCE", "REFERENCE_NOT_SUPPORTED_BY_SOURCE",
      "BINDING_ENTITY_MISMATCH", "OMITTED_EXPLICIT_PREFERENCE",
    ]));
  });

  it("returns only status and mismatches, rejects lifecycle authority, and never mutates inputs", () => {
    const sourceText = "Send Alex US$100.";
    const draft = Object.freeze({
      schemaVersion: "1", originalText: sourceText,
      goal: Object.freeze({ type: "DELIVER_MONEY", amount: Object.freeze({ currency: "USD", minorUnits: "10000" }), recipientReference: "Alex" }),
      constraints: Object.freeze([]), preferences: Object.freeze([]), references: Object.freeze([]),
    });
    const untrustedCandidate = Object.freeze({
      schemaVersion: "1", id: "goal-1", status: "CONFIRMED", contractHash: "a".repeat(64), confirmedAt: "2026-10-02T00:00:00Z",
      goal: Object.freeze({ type: "DELIVER_MONEY", amount: Object.freeze({ currency: "USD", minorUnits: "10000" }), recipientId: "ben-alex" }),
      constraints: Object.freeze([]), preferences: Object.freeze([]),
      entityBindings: Object.freeze([{ schemaVersion: "1", reference: "Alex", entityType: "BENEFICIARY", entityId: "ben-alex", resolutionMethod: "EXACT", confirmed: true }]),
    });
    const before = JSON.stringify({ draft, untrustedCandidate });

    const result = validator.validate({ sourceText, draft, candidate: untrustedCandidate });
    expect(Object.keys(result).sort()).toEqual(["mismatches", "status"]);
    expect(result).toEqual({ status: "FAIL", mismatches: [{ code: "INVALID_GOAL_CANDIDATE", field: "candidate" }] });
    expect(JSON.stringify({ draft, untrustedCandidate })).toBe(before);
  });
});
