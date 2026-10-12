import type { RiskReservationV1 } from "@parlance/contracts";
import { DEMO_RISK_POLICY_V1 } from "./policy.js";
import { PrismaRiskRepository } from "./repository.js";

type ExecutionRiskInput = {
  userId: string;
  financialPlanId: string;
  financialPlanHash: string;
  stepId: string;
  traceId: string;
  now: Date;
};

export interface ExecutionRiskGate {
  validateBeforeBankWrite(
    input: ExecutionRiskInput,
  ): Promise<RiskReservationV1>;

  settleAfterBankConfirmation(
    input: ExecutionRiskInput,
  ): Promise<RiskReservationV1>;

  releaseRemaining(input: {
    userId: string;
    financialPlanId: string;
    financialPlanHash: string;
    traceId: string;
    now: Date;
  }): Promise<boolean>;
}

export class DeterministicExecutionRiskGate
  implements ExecutionRiskGate
{
  constructor(
    private readonly repository: PrismaRiskRepository,
  ) {}

  validateBeforeBankWrite(input: ExecutionRiskInput) {
    return this.repository.validateStepForExecution({
      userId: input.userId,
      financialPlanId: input.financialPlanId,
      financialPlanHash: input.financialPlanHash,
      policy: DEMO_RISK_POLICY_V1,
      stepId: input.stepId,
      traceId: input.traceId,
      now: input.now,
    });
  }

  settleAfterBankConfirmation(input: ExecutionRiskInput) {
    return this.repository.settleStepForPlan({
      userId: input.userId,
      financialPlanId: input.financialPlanId,
      financialPlanHash: input.financialPlanHash,
      policyVersion: DEMO_RISK_POLICY_V1.policyVersion,
      stepId: input.stepId,
      traceId: input.traceId,
      now: input.now,
    });
  }

  releaseRemaining(input: {
    userId: string;
    financialPlanId: string;
    financialPlanHash: string;
    traceId: string;
    now: Date;
  }) {
    return this.repository.releaseActiveForPlan({
      userId: input.userId,
      financialPlanId: input.financialPlanId,
      financialPlanHash: input.financialPlanHash,
      policyVersion: DEMO_RISK_POLICY_V1.policyVersion,
      traceId: input.traceId,
      now: input.now,
    });
  }
}
