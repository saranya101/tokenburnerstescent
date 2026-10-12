import { describe, expect, it } from "vitest";
import {
  RiskAssessmentV1,
  RiskPolicyV1,
  RiskReservationV1,
} from "./risk.js";

const policy = {
  schemaVersion: "1",
  policyVersion: "demo-risk-v1",
  effectiveAt: "2026-10-03T00:00:00.000Z",
  rollingWindowSeconds: 86400,
  singleTransactionThresholds: [
    {
      currency: "USD",
      reviewAtMinorUnits: "500000",
      blockAtMinorUnits: "1000000",
    },
  ],
  rollingAmountThresholds: [
    {
      currency: "USD",
      reviewAtMinorUnits: "800000",
      blockAtMinorUnits: "1500000",
    },
  ],
  rollingCountThreshold: {
    reviewAt: 5,
    blockAt: 10,
  },
} as const;

describe("RiskPolicyV1", () => {
  it("accepts a deterministic versioned risk policy", () => {
    expect(RiskPolicyV1.parse(policy)).toEqual(policy);
  });

  it("rejects a review threshold above its block threshold", () => {
    expect(() => RiskPolicyV1.parse({
      ...policy,
      singleTransactionThresholds: [{
        currency: "USD",
        reviewAtMinorUnits: "1000001",
        blockAtMinorUnits: "1000000",
      }],
    })).toThrow();
  });

  it("rejects duplicate currency thresholds", () => {
    expect(() => RiskPolicyV1.parse({
      ...policy,
      singleTransactionThresholds: [
        ...policy.singleTransactionThresholds,
        ...policy.singleTransactionThresholds,
      ],
    })).toThrow();
  });
});

describe("RiskAssessmentV1", () => {
  const base = {
    schemaVersion: "1",
    id: "risk-assessment-1",
    userId: "user-1",
    financialPlanId: "plan-1",
    financialPlanHash: "a".repeat(64),
    bankStateVersion: 7,
    policyVersion: "demo-risk-v1",
    kycStatus: "VERIFIED",
    decision: "ALLOW",
    reasonCodes: [],
    exposures: [{
      stepId: "transfer-1",
      action: "TRANSFER",
      currency: "USD",
      minorUnits: "30000",
    }],
    rollingUsage: [{
      currency: "USD",
      windowStart: "2026-10-02T12:00:00.000Z",
      windowEnd: "2026-10-03T12:00:00.000Z",
      settledAmountMinorUnits: "0",
      reservedAmountMinorUnits: "0",
      settledTransactionCount: 0,
      reservedTransactionCount: 0,
    }],
    assessedAt: "2026-10-03T12:00:00.000Z",
    expiresAt: "2026-10-03T12:05:00.000Z",
  } as const;

  it("binds an ALLOW decision to the exact plan and policy", () => {
    expect(RiskAssessmentV1.parse(base)).toEqual(base);
  });

  it("requires a reason for REVIEW", () => {
    expect(() => RiskAssessmentV1.parse({
      ...base,
      decision: "REVIEW",
      reasonCodes: [],
    })).toThrow();
  });

  it("rejects reasons on ALLOW", () => {
    expect(() => RiskAssessmentV1.parse({
      ...base,
      reasonCodes: ["KYC_REVIEW_REQUIRED"],
    })).toThrow();
  });

  it("rejects expired-at-assessment evidence", () => {
    expect(() => RiskAssessmentV1.parse({
      ...base,
      expiresAt: base.assessedAt,
    })).toThrow();
  });

  it("rejects duplicate rolling usage currencies", () => {
    expect(() => RiskAssessmentV1.parse({
      ...base,
      rollingUsage: [
        ...base.rollingUsage,
        ...base.rollingUsage,
      ],
    })).toThrow();
  });

  it("rejects negative executable exposure", () => {
    expect(() => RiskAssessmentV1.parse({
      ...base,
      exposures: [{
        ...base.exposures[0],
        minorUnits: "-1",
      }],
    })).toThrow();
  });
});

describe("RiskReservationV1", () => {
  it("binds reserved velocity exposure to one exact financial plan", () => {
    const value = {
      schemaVersion: "1",
      id: "risk-reservation-1",
      userId: "user-1",
      assessmentId: "risk-assessment-1",
      financialPlanId: "plan-1",
      financialPlanHash: "a".repeat(64),
      policyVersion: "demo-risk-v1",
      exposures: [{
        stepId: "buy-1",
        action: "BUY_ASSET",
        currency: "USD",
        minorUnits: "20100",
      }],
      status: "ACTIVE",
      createdAt: "2026-10-03T12:00:00.000Z",
      expiresAt: "2026-10-03T12:05:00.000Z",
    } as const;

    expect(RiskReservationV1.parse(value)).toEqual(value);
    expect(RiskReservationV1.parse({
      ...value,
      status: "EXECUTING",
    }).status).toBe("EXECUTING");
  });
});
