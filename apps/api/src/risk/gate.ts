import type {
  RiskAssessmentV1,
  RiskReservationV1,
} from "@parlance/contracts";
import { DEMO_RISK_POLICY_V1 } from "./policy.js";
import {
  PrismaRiskRepository,
  type RiskReserveResult,
} from "./repository.js";

export interface ApprovalRiskGate {
  reserveForApproval(input: {
    userId: string;
    financialPlanId: string;
    traceId: string;
    now: Date;
  }): Promise<{
    assessment: RiskAssessmentV1;
    reservation: RiskReservationV1;
  }>;
}

export class DeterministicApprovalRiskGate
  implements ApprovalRiskGate
{
  constructor(
    private readonly repository: PrismaRiskRepository,
  ) {}

  async reserveForApproval(input: {
    userId: string;
    financialPlanId: string;
    traceId: string;
    now: Date;
  }) {
    const result: RiskReserveResult =
      await this.repository.reserve({
        userId: input.userId,
        financialPlanId: input.financialPlanId,
        policy: DEMO_RISK_POLICY_V1,
        traceId: input.traceId,
        now: input.now,
      });

    if (result.assessment.decision === "REVIEW") {
      throw new Error("RISK_REVIEW_REQUIRED");
    }

    if (result.assessment.decision === "BLOCK") {
      throw new Error("RISK_BLOCKED");
    }

    if (!result.reservation) {
      throw new Error("RISK_RESERVATION_MISSING");
    }

    return {
      assessment: result.assessment,
      reservation: result.reservation,
    };
  }
}
