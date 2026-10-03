import { z } from "zod";
import {
  CurrencyCode,
  Hash,
  Id,
  IsoTimestamp,
  NonNegativeMinorUnits,
  SchemaVersionV1,
} from "./common.js";
import { FinancialActionV1 } from "./operations.js";

export const KycStatusV1 = z.enum([
  "VERIFIED",
  "REVIEW_REQUIRED",
  "BLOCKED",
]);
export type KycStatusV1 = z.infer<typeof KycStatusV1>;

export const RiskDecisionV1 = z.enum([
  "ALLOW",
  "REVIEW",
  "BLOCK",
]);
export type RiskDecisionV1 = z.infer<typeof RiskDecisionV1>;

export const RiskReasonCodeV1 = z.enum([
  "KYC_REVIEW_REQUIRED",
  "KYC_BLOCKED",
  "SINGLE_TRANSACTION_REVIEW_THRESHOLD",
  "SINGLE_TRANSACTION_BLOCK_THRESHOLD",
  "ROLLING_AMOUNT_REVIEW_THRESHOLD",
  "ROLLING_AMOUNT_BLOCK_THRESHOLD",
  "ROLLING_COUNT_REVIEW_THRESHOLD",
  "ROLLING_COUNT_BLOCK_THRESHOLD",
  "CANNOT_PROVE_EXPOSURE",
  "POLICY_UNAVAILABLE",
]);
export type RiskReasonCodeV1 = z.infer<typeof RiskReasonCodeV1>;

export const RiskAmountThresholdV1 = z.object({
  currency: CurrencyCode,
  reviewAtMinorUnits: NonNegativeMinorUnits,
  blockAtMinorUnits: NonNegativeMinorUnits,
}).strict().superRefine((value, context) => {
  if (BigInt(value.reviewAtMinorUnits) > BigInt(value.blockAtMinorUnits)) {
    context.addIssue({
      code: "custom",
      path: ["reviewAtMinorUnits"],
      message: "review threshold must not exceed block threshold",
    });
  }
});
export type RiskAmountThresholdV1 = z.infer<typeof RiskAmountThresholdV1>;

export const RiskPolicyV1 = z.object({
  schemaVersion: SchemaVersionV1,
  policyVersion: z.string().min(1),
  effectiveAt: IsoTimestamp,

  rollingWindowSeconds: z.number().int().positive(),

  singleTransactionThresholds: z.array(RiskAmountThresholdV1),
  rollingAmountThresholds: z.array(RiskAmountThresholdV1),

  rollingCountThreshold: z.object({
    reviewAt: z.number().int().nonnegative(),
    blockAt: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.rollingCountThreshold.reviewAt > value.rollingCountThreshold.blockAt) {
    context.addIssue({
      code: "custom",
      path: ["rollingCountThreshold", "reviewAt"],
      message: "review threshold must not exceed block threshold",
    });
  }

  for (const field of [
    "singleTransactionThresholds",
    "rollingAmountThresholds",
  ] as const) {
    const currencies = value[field].map((item) => item.currency);
    if (new Set(currencies).size !== currencies.length) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "currency thresholds must be unique",
      });
    }
  }
});
export type RiskPolicyV1 = z.infer<typeof RiskPolicyV1>;

export const RiskExposureV1 = z.object({
  stepId: Id,
  action: FinancialActionV1,
  currency: CurrencyCode,
  minorUnits: NonNegativeMinorUnits,
}).strict();
export type RiskExposureV1 = z.infer<typeof RiskExposureV1>;

export const RiskVelocityUsageV1 = z.object({
  currency: CurrencyCode,
  windowStart: IsoTimestamp,
  windowEnd: IsoTimestamp,

  settledAmountMinorUnits: NonNegativeMinorUnits,
  reservedAmountMinorUnits: NonNegativeMinorUnits,

  settledTransactionCount: z.number().int().nonnegative(),
  reservedTransactionCount: z.number().int().nonnegative(),
}).strict();
export type RiskVelocityUsageV1 = z.infer<typeof RiskVelocityUsageV1>;

export const RiskAssessmentV1 = z.object({
  schemaVersion: SchemaVersionV1,
  id: Id,
  userId: Id,

  financialPlanId: Id,
  financialPlanHash: Hash,
  bankStateVersion: z.number().int().nonnegative(),

  policyVersion: z.string().min(1),
  kycStatus: KycStatusV1,

  decision: RiskDecisionV1,
  reasonCodes: z.array(RiskReasonCodeV1),

  exposures: z.array(RiskExposureV1),
  rollingUsage: z.array(RiskVelocityUsageV1),

  assessedAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
}).strict().superRefine((value, context) => {
  if (value.decision === "ALLOW" && value.reasonCodes.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["reasonCodes"],
      message: "ALLOW assessments must not contain blocking or review reasons",
    });
  }

  if (value.decision !== "ALLOW" && value.reasonCodes.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["reasonCodes"],
      message: "REVIEW and BLOCK assessments require at least one reason",
    });
  }

  if (Date.parse(value.expiresAt) <= Date.parse(value.assessedAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "risk assessment must expire after it is assessed",
    });
  }
});
export type RiskAssessmentV1 = z.infer<typeof RiskAssessmentV1>;

export const RiskReservationStatusV1 = z.enum([
  "ACTIVE",
  "CONSUMED",
  "RELEASED",
  "EXPIRED",
]);

export const RiskReservationV1 = z.object({
  schemaVersion: SchemaVersionV1,
  id: Id,
  userId: Id,
  assessmentId: Id,

  financialPlanId: Id,
  financialPlanHash: Hash,
  policyVersion: z.string().min(1),

  exposures: z.array(RiskExposureV1),

  status: RiskReservationStatusV1,
  createdAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  consumedAt: IsoTimestamp.optional(),
  releasedAt: IsoTimestamp.optional(),
}).strict();
export type RiskReservationV1 = z.infer<typeof RiskReservationV1>;
