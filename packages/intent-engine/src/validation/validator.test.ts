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
  it.each(["USD", "SGD"] as const)("rejects a model-invented %s currency for a bare dollar amount", (currency) => {
    const sourceText = "Send John $100";
    const draft = {
      schemaVersion: "1", originalText: sourceText,
      goal: { type: "DELIVER_MONEY", amount: { currency, minorUnits: "10000" }, recipientReference: "John" },
      constraints: [], preferences: [], references: [],
    };
    const result = validator.validate({
      sourceText,
      draft,
      candidate: candidate({
        goal: { type: "DELIVER_MONEY", amount: { currency, minorUnits: "10000" }, recipientId: "ben-john" },
        constraints: [], preferences: [],
        entityBindings: [{ schemaVersion: "1", reference: "John", entityType: "BENEFICIARY", entityId: "ben-john", resolutionMethod: "EXACT", confirmed: false }],
      }),
    });
    expect(result.status).toBe("FAIL");
    expect(result.mismatches).toContainEqual(expect.objectContaining({ code: "MONEY_NOT_SUPPORTED_BY_SOURCE", field: "goal.amount" }));
  });

  it.each([
    "Don't buy Apple. Send John USD 10.",
    "I told you not to buy Apple. Send John USD 10.",
    "I don't want to buy Apple. Send John USD 10.",
  ])("does not let a negated buy support an ACQUIRE_ASSET candidate: %s", (sourceText) => {
    const result = validator.validate({
      sourceText,
      draft: {
        schemaVersion: "1", originalText: sourceText,
        goal: { type: "ACQUIRE_ASSET", assetReference: "Apple", quantity: "1" },
        constraints: [], preferences: [], references: [],
      },
      candidate: candidate({
        goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" }, constraints: [], preferences: [],
        entityBindings: [{ schemaVersion: "1", reference: "Apple", entityType: "ASSET", entityId: "asset-aapl", resolutionMethod: "EXACT", confirmed: false }],
      }),
    });
    expect(result.mismatches).toContainEqual(expect.objectContaining({ code: "GOAL_TYPE_NOT_SUPPORTED_BY_SOURCE", field: "goal.type" }));
  });

  it.each([
    ["Buy one Apple share", "1", "PASS"],
    ["Buy one Apple share", "2", "FAIL"],
    ["Buy Apple", "10", "FAIL"],
    ["Buy 2 Apple shares", "2", "PASS"],
  ] as const)("independently proves acquisition quantity for: %s as %s", (sourceText, quantity, expectedStatus) => {
    const result = validator.validate({
      sourceText,
      draft: {
        schemaVersion: "1", originalText: sourceText,
        goal: { type: "ACQUIRE_ASSET", assetReference: "Apple", quantity },
        constraints: [], preferences: [], references: [],
      },
      candidate: candidate({
        goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity }, constraints: [], preferences: [],
        entityBindings: [{ schemaVersion: "1", reference: "Apple", entityType: "ASSET", entityId: "asset-aapl", resolutionMethod: "EXACT", confirmed: false }],
      }),
    });
    expect(result.status).toBe(expectedStatus);
    if (expectedStatus === "FAIL") expect(result.mismatches).toContainEqual(expect.objectContaining({ code: "QUANTITY_NOT_SUPPORTED_BY_SOURCE", field: "goal.quantity" }));
  });

  it("proves transfer amount and recipient only from the positive action clause", () => {
    const sourceText = "Don't send John USD 100. Send Sarah USD 20.";
    const validate = (recipientReference: string, recipientId: string, minorUnits: string) => validator.validate({
      sourceText,
      draft: {
        schemaVersion: "1", originalText: sourceText,
        goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits }, recipientReference },
        constraints: [], preferences: [], references: [],
      },
      candidate: candidate({
        goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits }, recipientId }, constraints: [], preferences: [],
        entityBindings: [{ schemaVersion: "1", reference: recipientReference, entityType: "BENEFICIARY", entityId: recipientId, resolutionMethod: "EXACT", confirmed: false }],
      }),
    });

    const negated = validate("John", "ben-john", "10000");
    expect(negated.status).toBe("FAIL");
    expect(codes(negated)).toEqual(expect.arrayContaining(["MONEY_NOT_SUPPORTED_BY_SOURCE", "REFERENCE_NOT_SUPPORTED_BY_SOURCE"]));
    expect(validate("Sarah", "ben-sarah", "2000")).toEqual({ status: "PASS", mismatches: [] });
  });

  it("does not let a later negated clause supply fields to an earlier positive action", () => {
    const sourceText = "Send Sarah USD 20. Don't send John USD 100.";
    const result = validator.validate({
      sourceText,
      draft: {
        schemaVersion: "1", originalText: sourceText,
        goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "10000" }, recipientReference: "John" },
        constraints: [], preferences: [], references: [],
      },
      candidate: candidate({
        goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "10000" }, recipientId: "ben-john" }, constraints: [], preferences: [],
        entityBindings: [{ schemaVersion: "1", reference: "John", entityType: "BENEFICIARY", entityId: "ben-john", resolutionMethod: "EXACT", confirmed: false }],
      }),
    });
    expect(result.status).toBe("FAIL");
    expect(codes(result)).toEqual(expect.arrayContaining(["MONEY_NOT_SUPPORTED_BY_SOURCE", "REFERENCE_NOT_SUPPORTED_BY_SOURCE"]));
  });

  it("does not use a negated bill clause to prove biller or amount", () => {
    const sourceText = "Never pay Example Power USD 100. Pay Example Water USD 20.";
    const result = validator.validate({
      sourceText,
      draft: {
        schemaVersion: "1", originalText: sourceText,
        goal: { type: "PAY_BILL", billerReference: "Example Power", amount: { currency: "USD", minorUnits: "10000" } },
        constraints: [], preferences: [], references: [],
      },
      candidate: candidate({
        goal: { type: "PAY_BILL", billerId: "biller-power", amount: { currency: "USD", minorUnits: "10000" } }, constraints: [], preferences: [],
        entityBindings: [{ schemaVersion: "1", reference: "Example Power", entityType: "BILLER", entityId: "biller-power", resolutionMethod: "EXACT", confirmed: false }],
      }),
    });
    expect(result.status).toBe("FAIL");
    expect(codes(result)).toEqual(expect.arrayContaining(["MONEY_NOT_SUPPORTED_BY_SOURCE", "REFERENCE_NOT_SUPPORTED_BY_SOURCE"]));
  });

  it("does not use a negated move clause to prove amount or destination", () => {
    const sourceText = "Don't move USD 500 to Savings. Move USD 20 to Checking.";
    const result = validator.validate({
      sourceText,
      draft: {
        schemaVersion: "1", originalText: sourceText,
        goal: { type: "MOVE_FUNDS", amount: { currency: "USD", minorUnits: "50000" }, destinationAccountReference: "Savings" },
        constraints: [], preferences: [], references: [],
      },
      candidate: candidate({
        goal: { type: "MOVE_FUNDS", amount: { currency: "USD", minorUnits: "50000" }, destinationAccountId: "acc-savings" }, constraints: [], preferences: [],
        entityBindings: [{ schemaVersion: "1", reference: "Savings", entityType: "ACCOUNT", entityId: "acc-savings", resolutionMethod: "EXACT", confirmed: false }],
      }),
    });
    expect(result.status).toBe("FAIL");
    expect(codes(result)).toEqual(expect.arrayContaining(["MONEY_NOT_SUPPORTED_BY_SOURCE", "REFERENCE_NOT_SUPPORTED_BY_SOURCE"]));
  });

  it("fails closed when a single-intent validation contains multiple positive actions", () => {
    const sourceText = "Send John USD 10 and send Sarah USD 20.";
    const result = validator.validate({
      sourceText,
      draft: {
        schemaVersion: "1", originalText: sourceText,
        goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "1000" }, recipientReference: "John" },
        constraints: [], preferences: [], references: [],
      },
      candidate: candidate({
        goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "1000" }, recipientId: "ben-john" }, constraints: [], preferences: [],
        entityBindings: [{ schemaVersion: "1", reference: "John", entityType: "BENEFICIARY", entityId: "ben-john", resolutionMethod: "EXACT", confirmed: false }],
      }),
    });
    expect(result.mismatches).toContainEqual(expect.objectContaining({ code: "GOAL_CLAUSE_NOT_UNAMBIGUOUS", field: "goal" }));
  });

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

  it("accepts an explicit customer-authored source-account preference", () => {
    const sourceText = "I need to send NTU 7,000 USD. I only have 5,000 in my USD account, so use my SGD account for the rest.";
    const draft = {
      schemaVersion: "1", originalText: sourceText,
      goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientReference: "NTU" }, constraints: [],
      preferences: [{ type: "PREFER_ACCOUNT", accountReference: "my SGD account" }], references: [],
    };
    const goalCandidate = candidate({
      goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientId: "ben-ntu" }, constraints: [],
      preferences: [{ type: "PREFER_ACCOUNT", accountId: "acc-sgd" }],
      entityBindings: [
        { schemaVersion: "1", reference: "NTU", entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "EXACT", confirmed: false },
        { schemaVersion: "1", reference: "my SGD account", entityType: "ACCOUNT", entityId: "acc-sgd", resolutionMethod: "EXACT", confirmed: false },
      ],
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
