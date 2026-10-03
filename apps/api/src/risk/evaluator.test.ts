import { describe, expect, it } from "vitest";
import {
  FinancialPlanV1,
  RiskPolicyV1,
  type FinancialPlanV1 as Plan,
  type RiskVelocityUsageV1,
} from "@parlance/contracts";
import {
  evaluateRisk,
  extractPlanRiskExposures,
} from "./evaluator.js";

const now = new Date("2026-10-03T12:00:00.000Z");

const policy = RiskPolicyV1.parse({
  schemaVersion: "1",
  policyVersion: "demo-risk-v1",
  effectiveAt: "2026-10-03T00:00:00.000Z",
  rollingWindowSeconds: 86400,

  singleTransactionThresholds: [
    {
      currency: "USD",
      reviewAtMinorUnits: "300000",
      blockAtMinorUnits: "450000",
    },
    {
      currency: "SGD",
      reviewAtMinorUnits: "1000000",
      blockAtMinorUnits: "1500000",
    },
  ],

  rollingAmountThresholds: [
    {
      currency: "USD",
      reviewAtMinorUnits: "400000",
      blockAtMinorUnits: "500000",
    },
    {
      currency: "SGD",
      reviewAtMinorUnits: "1500000",
      blockAtMinorUnits: "1900000",
    },
  ],

  rollingCountThreshold: {
    reviewAt: 5,
    blockAt: 10,
  },
});

function plan(
  steps: Plan["steps"],
  id = "plan-1",
): Plan {
  return FinancialPlanV1.parse({
    schemaVersion: "1",
    id,
    goalContractId: "goal-1",
    goalContractVersion: 1,
    bankStateVersion: 7,
    compilerVersion: "test-compiler",
    policyVersion: "compiler-policy-v1",
    operationLibraryVersion: "test-operations",

    steps,

    validity: {
      requiredQuoteIds: steps
        .filter((step) => step.action === "BUY_ASSET")
        .map((step) =>
          step.action === "BUY_ASSET"
            ? step.parameters.quoteId
            : "",
        ),
    },

    projectedOutcome: {
      goalSatisfied: true,
      acquiredAssets: [],
      paidObligationIds: [],
      projectedAvailableBalances: [],
      warnings: [],
    },

    planHash: "a".repeat(64),
  });
}

function transfer(minorUnits: string, id = "transfer-1") {
  return {
    id,
    sequence: 0,
    dependsOn: [],
    reversible: false,
    action: "TRANSFER" as const,
    parameters: {
      sourceAccountId: "acc-usd",
      beneficiaryId: "ben-john-1",
      amount: {
        currency: "USD",
        minorUnits,
      },
    },
  };
}

function buy(minorUnits = "20100") {
  return {
    id: "buy-1",
    sequence: 1,
    dependsOn: ["transfer-1"],
    reversible: false,
    action: "BUY_ASSET" as const,
    parameters: {
      sourceAccountId: "acc-usd",
      assetId: "asset-aapl",
      quantity: "1",
      maximumSpend: {
        currency: "USD",
        minorUnits,
      },
      quoteId: "asset-quote-aapl-usd-v1",
      settlementCurrency: "USD",
      quotedUnitPriceMinor: "20000",
      quotedFeeMinor: "100",
      authorizedTotalMinor: minorUnits,
    },
  };
}

function usage(
  overrides: Partial<RiskVelocityUsageV1> = {},
): RiskVelocityUsageV1 {
  return {
    currency: "USD",
    windowStart: "2026-10-02T12:00:00.000Z",
    windowEnd: "2026-10-03T12:00:00.000Z",
    settledAmountMinorUnits: "0",
    reservedAmountMinorUnits: "0",
    settledTransactionCount: 0,
    reservedTransactionCount: 0,
    ...overrides,
  };
}

function assess(
  financialPlan: Plan,
  overrides: Partial<Parameters<typeof evaluateRisk>[0]> = {},
) {
  return evaluateRisk({
    assessmentId: "assessment-1",
    userId: "user-1",
    plan: financialPlan,
    policy,
    kycStatus: "VERIFIED",
    rollingUsage: [],
    now,
    ...overrides,
  });
}

describe("extractPlanRiskExposures", () => {
  it("extracts exact debit exposure from transfer and BUY_ASSET", () => {
    const exposures = extractPlanRiskExposures(
      plan([transfer("30000"), buy("20100")]),
    );

    expect(exposures).toEqual([
      {
        stepId: "transfer-1",
        action: "TRANSFER",
        currency: "USD",
        minorUnits: "30000",
      },
      {
        stepId: "buy-1",
        action: "BUY_ASSET",
        currency: "USD",
        minorUnits: "20100",
      },
    ]);
  });
});

describe("evaluateRisk", () => {
  it("allows the headline USD 300 + USD 201 plan", () => {
    const result = assess(
      plan([transfer("30000"), buy("20100")]),
    );

    expect(result.decision).toBe("ALLOW");
    expect(result.reasonCodes).toEqual([]);
  });

  it("counts a same-currency multi-step plan once", () => {
    const result = assess(
      plan([transfer("30000"), buy("20100")]),
      {
        rollingUsage: [
          usage({ settledTransactionCount: 3 }),
        ],
      },
    );

    expect(result.decision).toBe("ALLOW");
    expect(result.reasonCodes).not.toContain(
      "ROLLING_COUNT_REVIEW_THRESHOLD",
    );
  });

  it("evaluates rolling count independently for each affected currency", () => {
    const result = assess(
      plan([
        transfer("10000"),
        {
          id: "sgd-transfer",
          sequence: 1,
          dependsOn: [],
          reversible: false,
          action: "TRANSFER",
          parameters: {
            sourceAccountId: "acc-sgd",
            beneficiaryId: "ben-test",
            amount: { currency: "SGD", minorUnits: "10000" },
          },
        },
      ]),
      {
        rollingUsage: [
          usage({ settledTransactionCount: 2 }),
          usage({
            currency: "SGD",
            settledTransactionCount: 2,
          }),
        ],
      },
    );

    expect(result.decision).toBe("ALLOW");
    expect(result.reasonCodes).not.toContain(
      "ROLLING_COUNT_REVIEW_THRESHOLD",
    );
  });

  it("reviews an exact-plan USD 3,000 exposure", () => {
    const result = assess(plan([transfer("300000")]));

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain(
      "SINGLE_TRANSACTION_REVIEW_THRESHOLD",
    );
  });

  it("blocks an exact-plan USD 4,500 exposure", () => {
    const result = assess(plan([transfer("450000")]));

    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toContain(
      "SINGLE_TRANSACTION_BLOCK_THRESHOLD",
    );
  });

  it("requires review when KYC requires review", () => {
    const result = assess(
      plan([transfer("30000")]),
      { kycStatus: "REVIEW_REQUIRED" },
    );

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("KYC_REVIEW_REQUIRED");
  });

  it("blocks when KYC is blocked", () => {
    const result = assess(
      plan([transfer("30000")]),
      { kycStatus: "BLOCKED" },
    );

    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toContain("KYC_BLOCKED");
  });

  it("includes settled rolling exposure", () => {
    const result = assess(
      plan([transfer("30000")]),
      {
        rollingUsage: [
          usage({
            settledAmountMinorUnits: "380000",
          }),
        ],
      },
    );

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain(
      "ROLLING_AMOUNT_REVIEW_THRESHOLD",
    );
  });

  it("includes reserved rolling exposure", () => {
    const result = assess(
      plan([transfer("30000")]),
      {
        rollingUsage: [
          usage({
            reservedAmountMinorUnits: "470000",
          }),
        ],
      },
    );

    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toContain(
      "ROLLING_AMOUNT_BLOCK_THRESHOLD",
    );
  });

  it("includes pending reservations in velocity count", () => {
    const result = assess(
      plan([transfer("30000")]),
      {
        rollingUsage: [
          usage({
            settledTransactionCount: 2,
            reservedTransactionCount: 2,
          }),
        ],
      },
    );

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain(
      "ROLLING_COUNT_REVIEW_THRESHOLD",
    );
  });

  it("fails closed when an exposure cannot be proven", () => {
    const sellPlan = plan([
      {
        id: "sell-1",
        sequence: 0,
        dependsOn: [],
        reversible: false,
        action: "SELL_ASSET",
        parameters: {
          destinationAccountId: "acc-usd",
          assetId: "asset-aapl",
          quantity: "1",
        },
      },
    ]);

    const result = assess(sellPlan);

    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toContain(
      "CANNOT_PROVE_EXPOSURE",
    );
  });

  it("fails closed for an empty financial plan", () => {
    const result = assess(plan([]));

    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toContain("CANNOT_PROVE_EXPOSURE");
    expect(result.exposures).toEqual([]);
  });

  it("fails closed cleanly for a negative debit exposure", () => {
    const result = assess(plan([transfer("-1")]));

    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toContain("CANNOT_PROVE_EXPOSURE");
    expect(result.exposures).toEqual([]);
  });

  it("fails closed for duplicate rolling usage regardless of row order", () => {
    const smaller = usage({ settledAmountMinorUnits: "10000" });
    const larger = usage({ settledAmountMinorUnits: "490000" });

    const forward = assess(plan([transfer("10000")]), {
      rollingUsage: [smaller, larger],
    });
    const reversed = assess(plan([transfer("10000")]), {
      rollingUsage: [larger, smaller],
    });

    for (const result of [forward, reversed]) {
      expect(result.decision).toBe("BLOCK");
      expect(result.reasonCodes).toContain("POLICY_UNAVAILABLE");
      expect(result.rollingUsage).toEqual([]);
    }
  });

  it("fails closed when policy lacks the exposure currency", () => {
    const sgdPlan = plan([
      {
        id: "sgd-transfer",
        sequence: 0,
        dependsOn: [],
        reversible: false,
        action: "TRANSFER",
        parameters: {
          sourceAccountId: "acc-sgd",
          beneficiaryId: "ben-1",
          amount: {
            currency: "EUR",
            minorUnits: "10000",
          },
        },
      },
    ]);

    const result = assess(sgdPlan);

    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toContain("POLICY_UNAVAILABLE");
  });

  it("fails closed when the configured policy is not effective yet", () => {
    const futurePolicy = RiskPolicyV1.parse({
      ...policy,
      effectiveAt: "2026-10-04T00:00:00.000Z",
    });

    const result = assess(
      plan([transfer("30000")]),
      { policy: futurePolicy },
    );

    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toContain("POLICY_UNAVAILABLE");
  });

  it("binds the result to exact plan hash, state and policy", () => {
    const result = assess(plan([transfer("30000")]));

    expect(result.financialPlanId).toBe("plan-1");
    expect(result.financialPlanHash).toBe("a".repeat(64));
    expect(result.bankStateVersion).toBe(7);
    expect(result.policyVersion).toBe("demo-risk-v1");
  });
});
