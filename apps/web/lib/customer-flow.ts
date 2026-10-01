import type { ExecutionResultV1, FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import type { Clarification, ClarificationOption, GoalCandidate, MessageResponse, ParlanceApi } from "./parlance-api";
import { PasskeyCancelledError, type PasskeyClient } from "./passkey";

type Context = { requestText: string; goal: GoalContractV1; plan: FinancialPlanV1 };
export type CustomerFlowState =
  | { phase: "COMPOSE" }
  | { phase: "INTERPRETING"; requestText: string }
  | { phase: "CLARIFICATION"; requestText: string; clarificationId: string; clarifications: Clarification[]; answers: ClarificationAnswer[] }
  | { phase: "GOAL_REVIEW"; requestText: string; candidateId: string; candidate: GoalCandidate; answers: ClarificationAnswer[] }
  | { phase: "CONFIRMING_GOAL"; requestText: string; candidate: GoalCandidate }
  | { phase: "GOAL_CONFIRMATION_FAILED"; requestText: string; candidateId: string; candidate: GoalCandidate; message: string }
  | { phase: "COMPILING"; requestText: string; goal: GoalContractV1 }
  | ({ phase: "PLAN_REVIEW"; refreshed?: boolean; passkeyReady?: boolean } & Context)
  | ({ phase: "PASSKEY_REQUIRED" } & Context)
  | ({ phase: "AUTHORIZING" } & Context)
  | ({ phase: "PASSKEY_CANCELLED" } & Context)
  | ({ phase: "APPROVAL_FAILED"; message: string } & Context)
  | ({ phase: "EXECUTING"; executionId: string } & Context)
  | ({ phase: "COMPLETED"; result: ExecutionResultV1 } & Context)
  | ({ phase: "PAUSED"; result: ExecutionResultV1 } & Context)
  | ({ phase: "REAPPROVAL_REQUIRED"; result: ExecutionResultV1 } & Context)
  | { phase: "UNAVAILABLE"; requestText: string; kind: "UNSAT" | "POLICY_BLOCKED"; message: string }
  | ({ phase: "EXECUTION_ERROR"; message: string; result?: ExecutionResultV1 } & Context)
  | { phase: "ERROR"; requestText?: string; message: string };

export type StateListener = (state: CustomerFlowState) => void;
export type ClarificationAnswer = { reference: string; answer: string };

function message(error: unknown): string { return error instanceof Error ? error.message : "REQUEST_FAILED"; }

export class CustomerFlowController {
  state: CustomerFlowState = { phase: "COMPOSE" };
  private meaningConfirmationInFlight = false;
  private clarificationInFlight = false;
  constructor(private readonly api: ParlanceApi, private readonly passkey: PasskeyClient, private readonly listener: StateListener = () => undefined) {}

  private transition(state: CustomerFlowState): void { this.state = state; this.listener(state); }

  async submitMessage(requestText: string): Promise<void> { await this.interpret(requestText.trim(), requestText.trim()); }

  private async interpret(text: string, requestText: string): Promise<void> {
    if (!text) return;
    this.transition({ phase: "INTERPRETING", requestText });
    try {
      const response = await this.api.sendMessage(text);
      this.applyInterpretation(response, requestText, []);
    } catch (error) { this.transition({ phase: "ERROR", requestText, message: message(error) }); }
  }

  async answerClarification(clarification: Clarification, option: ClarificationOption): Promise<void> {
    if (this.state.phase !== "CLARIFICATION") throw new Error("INVALID_FLOW_STATE");
    await this.continueClarification(clarification, { selectedCandidateId: option.entityId }, option.displayName);
  }

  async answerClarificationText(clarification: Clarification, answerText: string): Promise<void> {
    if (this.state.phase !== "CLARIFICATION") throw new Error("INVALID_FLOW_STATE");
    const answer = answerText.trim(); if (!answer) return;
    await this.continueClarification(clarification, { answerText: answer }, answer);
  }

  private async continueClarification(clarification: Clarification, answer: { selectedCandidateId: string } | { answerText: string }, displayAnswer: string): Promise<void> {
    if (this.clarificationInFlight) return;
    if (this.state.phase !== "CLARIFICATION") throw new Error("INVALID_FLOW_STATE");
    const { requestText, clarificationId, answers } = this.state;
    this.clarificationInFlight = true;
    try {
      const response = await this.api.answerClarification(clarificationId, answer);
      this.applyInterpretation(response, requestText, [...answers, { reference: clarification.originalReference, answer: displayAnswer }]);
    } catch (error) { this.transition({ phase: "ERROR", requestText, message: message(error) }); }
    finally { this.clarificationInFlight = false; }
  }

  private applyInterpretation(response: MessageResponse, requestText: string, answers: ClarificationAnswer[]): void {
    if (response.status === "NEEDS_CLARIFICATION") this.transition({ phase: "CLARIFICATION", requestText, clarificationId: response.clarificationId, clarifications: response.clarifications, answers });
    else this.transition({ phase: "GOAL_REVIEW", requestText, candidateId: response.candidateId, candidate: response.goalCandidate, answers });
  }

  async confirmMeaning(): Promise<void> {
    if (this.meaningConfirmationInFlight) return;
    if (!(this.state.phase === "GOAL_REVIEW" || this.state.phase === "GOAL_CONFIRMATION_FAILED")) throw new Error("INVALID_FLOW_STATE");
    const { candidateId, candidate, requestText } = this.state;
    this.meaningConfirmationInFlight = true;
    this.transition({ phase: "CONFIRMING_GOAL", requestText, candidate });
    try {
      let goal: GoalContractV1;
      try {
        goal = await this.api.confirmGoal(candidateId);
      } catch (error) {
        this.transition({ phase: "GOAL_CONFIRMATION_FAILED", requestText, candidateId, candidate, message: message(error) });
        return;
      }
      this.transition({ phase: "COMPILING", requestText, goal });
      try {
        const result = await this.api.compileGoal(goal.id);
        if (result.status === "SAT") this.transition({ phase: "PLAN_REVIEW", requestText, goal, plan: result.plan });
        else this.transition({ phase: "UNAVAILABLE", requestText, kind: result.status, message: result.reason.message });
      } catch (error) {
        this.transition({ phase: "ERROR", requestText, message: message(error) });
      }
    } finally {
      this.meaningConfirmationInFlight = false;
    }
  }

  async authorizeAndExecute(): Promise<void> {
    if (!(this.state.phase === "PLAN_REVIEW" || this.state.phase === "PASSKEY_CANCELLED" || this.state.phase === "APPROVAL_FAILED")) throw new Error("INVALID_FLOW_STATE");
    const context: Context = { requestText: this.state.requestText, goal: this.state.goal, plan: this.state.plan };
    this.transition({ phase: "AUTHORIZING", ...context });
    let executionId: string;
    try {
      const issued = await this.api.approvalOptions(context.plan.id);
      const credential = await this.passkey.request(issued.options);
      const authorized = await this.api.verifyApproval(context.plan.id, issued.challengeId, credential);
      executionId = authorized.execution.executionId;
    } catch (error) {
      if (message(error) === "FINANCIAL_PLAN_EXPIRED") { await this.refreshExpiredPlan(context); }
      else if (message(error) === "PASSKEY_CREDENTIAL_NOT_FOUND") this.transition({ phase: "PASSKEY_REQUIRED", ...context });
      else if (error instanceof PasskeyCancelledError) this.transition({ phase: "PASSKEY_CANCELLED", ...context });
      else this.transition({ phase: "APPROVAL_FAILED", ...context, message: message(error) });
      return;
    }

    this.transition({ phase: "EXECUTING", ...context, executionId });
    try {
      const result = await this.api.runExecution(executionId);
      if (result.status === "COMPLETED") { this.transition({ phase: "COMPLETED", ...context, result }); return; }
      if (result.status === "FAILED") { this.transition({ phase: "EXECUTION_ERROR", ...context, result, message: result.goalOutcome.summary }); return; }
      if (result.status === "UNKNOWN") {
        const detail = await this.api.executionDetail(executionId);
        if (detail.state === "REAPPROVAL_REQUIRED") this.transition({ phase: "REAPPROVAL_REQUIRED", ...context, result: detail.result });
        else if (detail.state === "PAUSED") this.transition({ phase: "PAUSED", ...context, result: detail.result });
        else this.transition({ phase: "EXECUTION_ERROR", ...context, result: detail.result, message: "The final execution state could not be confirmed." });
        return;
      }
      this.transition({ phase: "EXECUTION_ERROR", ...context, result, message: "The execution did not reach a final state." });
    } catch (error) { this.transition({ phase: "EXECUTION_ERROR", ...context, message: message(error) }); }
  }

  async passkeyEnrolled(): Promise<void> {
    if (this.state.phase !== "PASSKEY_REQUIRED") throw new Error("INVALID_FLOW_STATE");
    const context: Context = { requestText: this.state.requestText, goal: this.state.goal, plan: this.state.plan };
    const validUntil = context.plan.validity.validUntil;
    if (validUntil !== undefined && Date.now() >= Date.parse(validUntil)) { await this.refreshExpiredPlan(context); return; }
    this.transition({ phase: "PLAN_REVIEW", ...context, passkeyReady: true });
  }

  private async refreshExpiredPlan(context: Context): Promise<void> {
    this.transition({ phase: "COMPILING", requestText: context.requestText, goal: context.goal });
    try {
      const result = await this.api.compileGoal(context.goal.id);
      if (result.status === "SAT") this.transition({ phase: "PLAN_REVIEW", requestText: context.requestText, goal: context.goal, plan: result.plan, refreshed: true });
      else this.transition({ phase: "UNAVAILABLE", requestText: context.requestText, kind: result.status, message: result.reason.message });
    } catch (error) {
      this.transition({ phase: "ERROR", requestText: context.requestText, message: message(error) });
    }
  }

  reset(): void { this.transition({ phase: "COMPOSE" }); }
}
