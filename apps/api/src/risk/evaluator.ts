import {
  FinancialPlanV1,
  RiskAssessmentV1,
  RiskExposureV1,
  RiskPolicyV1,
  RiskVelocityUsageV1,
  type KycStatusV1,
  type RiskAssessmentV1 as RiskAssessment,
  type RiskExposureV1 as RiskExposure,
  type RiskPolicyV1 as RiskPolicy,
  type RiskReasonCodeV1,
  type RiskVelocityUsageV1 as RiskVelocityUsage,
} from "@parlance/contracts";

const ASSESSMENT_TTL_MS = 5 * 60 * 1000;

export class RiskExposureUnprovableError extends Error {
  constructor(action: string) {
    super(`RISK_EXPOSURE_UNPROVABLE:${action}`);
  }
}

export function extractPlanRiskExposures(
  input: FinancialPlanV1,
): RiskExposure[] {
  const plan = FinancialPlanV1.parse(input);

  if (plan.steps.length === 0) {
    throw new RiskExposureUnprovableError("EMPTY_PLAN");
  }

  return plan.steps.map((step): RiskExposure => {
    let exposure: unknown;

    switch (step.action) {
      case "TRANSFER":
        exposure = {
          stepId: step.id,
          action: step.action,
          currency: step.parameters.amount.currency,
          minorUnits: step.parameters.amount.minorUnits,
        };
        break;

      case "FX_CONVERT":
        exposure = {
          stepId: step.id,
          action: step.action,
          currency: step.parameters.sourceMoney.currency,
          minorUnits: step.parameters.sourceMoney.minorUnits,
        };
        break;

      case "MOVE_FUNDS":
        exposure = {
          stepId: step.id,
          action: step.action,
          currency: step.parameters.amount.currency,
          minorUnits: step.parameters.amount.minorUnits,
        };
        break;

      case "PAY_BILL":
        exposure = {
          stepId: step.id,
          action: step.action,
          currency: step.parameters.amount.currency,
          minorUnits: step.parameters.amount.minorUnits,
        };
        break;

      case "BUY_ASSET":
        exposure = {
          stepId: step.id,
          action: step.action,
          currency: step.parameters.settlementCurrency,
          minorUnits: step.parameters.authorizedTotalMinor,
        };
        break;

      case "SELL_ASSET":
        // SELL_ASSET currently has no exact monetary proceeds bound into
        // FinancialPlanStepV1, so Risk V1 deliberately fails closed.
        throw new RiskExposureUnprovableError(step.action);
    }

    const parsed = RiskExposureV1.safeParse(exposure);

    if (!parsed.success) {
      throw new RiskExposureUnprovableError(step.action);
    }

    return parsed.data;
  });
}

type EvaluateRiskInput = {
  assessmentId: string;
  userId: string;
  plan: FinancialPlanV1;
  policy: RiskPolicy;
  kycStatus: KycStatusV1;
  rollingUsage: RiskVelocityUsage[];
  now: Date;
};

type Severity = "ALLOW" | "REVIEW" | "BLOCK";

function worse(a: Severity, b: Severity): Severity {
  if (a === "BLOCK" || b === "BLOCK") return "BLOCK";
  if (a === "REVIEW" || b === "REVIEW") return "REVIEW";
  return "ALLOW";
}

function thresholdFor(
  values: RiskPolicy["singleTransactionThresholds"],
  currency: string,
) {
  return values.find((item) => item.currency === currency);
}

function amountByCurrency(exposures: RiskExposure[]) {
  const totals = new Map<string, bigint>();

  for (const exposure of exposures) {
    totals.set(
      exposure.currency,
      (totals.get(exposure.currency) ?? 0n) + BigInt(exposure.minorUnits),
    );
  }

  return totals;
}

function zeroUsage(
  currency: string,
  policy: RiskPolicy,
  now: Date,
): RiskVelocityUsage {
  const windowEnd = now;
  const windowStart = new Date(
    windowEnd.getTime() - policy.rollingWindowSeconds * 1000,
  );

  return RiskVelocityUsageV1.parse({
    currency,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    settledAmountMinorUnits: "0",
    reservedAmountMinorUnits: "0",
    settledTransactionCount: 0,
    reservedTransactionCount: 0,
  });
}

export function evaluateRisk(input: EvaluateRiskInput): RiskAssessment {
  const plan = FinancialPlanV1.parse(input.plan);
  const policy = RiskPolicyV1.parse(input.policy);
  const now = new Date(input.now);

  let decision: Severity = "ALLOW";
  const reasons = new Set<RiskReasonCodeV1>();

  const parsedUsage = input.rollingUsage.map((usage) =>
    RiskVelocityUsageV1.safeParse(usage),
  );
  const validUsage = parsedUsage.flatMap((result) =>
    result.success ? [result.data] : [],
  );
  const usageCurrencies = validUsage.map((usage) => usage.currency);
  const rollingUsageValid =
    validUsage.length === input.rollingUsage.length &&
    new Set(usageCurrencies).size === usageCurrencies.length;

  if (!rollingUsageValid) {
    decision = "BLOCK";
    reasons.add("POLICY_UNAVAILABLE");
  }

  if (Date.parse(policy.effectiveAt) > now.getTime()) {
    decision = "BLOCK";
    reasons.add("POLICY_UNAVAILABLE");
  }

  let exposures: RiskExposure[];

  try {
    exposures = extractPlanRiskExposures(plan);
  } catch (error) {
    if (!(error instanceof RiskExposureUnprovableError)) throw error;

    decision = "BLOCK";
    reasons.add("CANNOT_PROVE_EXPOSURE");
    exposures = [];
  }

  if (input.kycStatus === "BLOCKED") {
    decision = "BLOCK";
    reasons.add("KYC_BLOCKED");
  } else if (input.kycStatus === "REVIEW_REQUIRED") {
    decision = worse(decision, "REVIEW");
    reasons.add("KYC_REVIEW_REQUIRED");
  }

  const totals = amountByCurrency(exposures);
  const usageByCurrency = new Map(
    validUsage.map((usage) => [
      usage.currency,
      usage,
    ]),
  );

  for (const [currency, planAmount] of totals) {
    const single = thresholdFor(
      policy.singleTransactionThresholds,
      currency,
    );
    const rolling = thresholdFor(
      policy.rollingAmountThresholds,
      currency,
    );

    if (!single || !rolling) {
      decision = "BLOCK";
      reasons.add("POLICY_UNAVAILABLE");
      continue;
    }

    const singleReview = BigInt(single.reviewAtMinorUnits);
    const singleBlock = BigInt(single.blockAtMinorUnits);

    if (planAmount >= singleBlock) {
      decision = "BLOCK";
      reasons.add("SINGLE_TRANSACTION_BLOCK_THRESHOLD");
    } else if (planAmount >= singleReview) {
      decision = worse(decision, "REVIEW");
      reasons.add("SINGLE_TRANSACTION_REVIEW_THRESHOLD");
    }

    const usage = usageByCurrency.get(currency);

    // Absence is semantically zero usage for a currency with no previous
    // settled/reserved activity. Persistence will later produce explicit
    // rows once velocity reservations exist.
    const effectiveUsage = usage ?? zeroUsage(currency, policy, now);

    const priorAmount =
      BigInt(effectiveUsage.settledAmountMinorUnits) +
      BigInt(effectiveUsage.reservedAmountMinorUnits);

    const projectedRollingAmount = priorAmount + planAmount;

    if (projectedRollingAmount >= BigInt(rolling.blockAtMinorUnits)) {
      decision = "BLOCK";
      reasons.add("ROLLING_AMOUNT_BLOCK_THRESHOLD");
    } else if (
      projectedRollingAmount >= BigInt(rolling.reviewAtMinorUnits)
    ) {
      decision = worse(decision, "REVIEW");
      reasons.add("ROLLING_AMOUNT_REVIEW_THRESHOLD");
    }

    // One FinancialPlan contributes one transaction for each affected
    // currency, regardless of how many same-currency steps it contains.
    const projectedCount =
      effectiveUsage.settledTransactionCount +
      effectiveUsage.reservedTransactionCount +
      1;

    if (projectedCount >= policy.rollingCountThreshold.blockAt) {
      decision = "BLOCK";
      reasons.add("ROLLING_COUNT_BLOCK_THRESHOLD");
    } else if (
      projectedCount >= policy.rollingCountThreshold.reviewAt
    ) {
      decision = worse(decision, "REVIEW");
      reasons.add("ROLLING_COUNT_REVIEW_THRESHOLD");
    }
  }

  return RiskAssessmentV1.parse({
    schemaVersion: "1",
    id: input.assessmentId,
    userId: input.userId,

    financialPlanId: plan.id,
    financialPlanHash: plan.planHash,
    bankStateVersion: plan.bankStateVersion,

    policyVersion: policy.policyVersion,
    kycStatus: input.kycStatus,

    decision,
    reasonCodes: [...reasons],

    exposures,
    rollingUsage: rollingUsageValid ? validUsage : [],

    assessedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + ASSESSMENT_TTL_MS,
    ).toISOString(),
  });
}
