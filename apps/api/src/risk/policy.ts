import { RiskPolicyV1 } from "@parlance/contracts";

export const DEMO_RISK_POLICY_V1 = RiskPolicyV1.parse({
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
