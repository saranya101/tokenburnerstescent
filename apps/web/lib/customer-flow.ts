import type { ExecutionResultV1, FinancialPlanV1, GoalBundleContractV1, GoalContractV1 } from "@parlance/contracts";
import type { Clarification, ClarificationOption, ExecutionDetail, GoalBundleCandidate, GoalCandidate, MessageInputProvenance, MessageResponse, ParlanceApi } from "./parlance-api";
import { PasskeyCancelledError, type PasskeyClient } from "./passkey";

type Context = { requestText: string; plan: FinancialPlanV1 } & ({ goal: GoalContractV1; bundle?: never } | { bundle: GoalBundleContractV1; goal?: never });
type ExecutionContext = Context & { executionId: string };
export type CustomerFlowState =
  | { phase: "RESTORING_EXECUTION" }
  | { phase: "COMPOSE" }
  | { phase: "INTERPRETING"; requestText: string }
  | { phase: "CLARIFICATION"; requestText: string; clarificationId: string; clarifications: Clarification[]; answers: ClarificationAnswer[]; bundle: boolean }
  | { phase: "SEMANTIC_VALIDATION_FAILED"; requestText: string; message: string }
  | { phase: "GOAL_REVIEW"; requestText: string; candidateId: string; candidate: GoalCandidate; answers: ClarificationAnswer[] }
  | { phase: "BUNDLE_REVIEW"; requestText: string; candidateId: string; candidate: GoalBundleCandidate; answers: ClarificationAnswer[] }
  | { phase: "CONFIRMING_GOAL"; requestText: string; candidate: GoalCandidate }
  | { phase: "CONFIRMING_BUNDLE"; requestText: string; candidate: GoalBundleCandidate }
  | { phase: "GOAL_CONFIRMATION_FAILED"; requestText: string; candidateId: string; candidate: GoalCandidate; message: string }
  | { phase: "BUNDLE_CONFIRMATION_FAILED"; requestText: string; candidateId: string; candidate: GoalBundleCandidate; message: string }
  | { phase: "COMPILING"; requestText: string; goal: GoalContractV1 }
  | { phase: "COMPILING_BUNDLE"; requestText: string; bundle: GoalBundleContractV1 }
  | ({ phase: "PLAN_REVIEW"; refreshed?: boolean; passkeyReady?: boolean } & Context)
  | ({ phase: "PASSKEY_REQUIRED" } & Context)
  | ({ phase: "AUTHORIZING" } & Context)
  | ({ phase: "PASSKEY_CANCELLED" } & Context)
  | ({ phase: "APPROVAL_FAILED"; message: string } & Context)
  | ({ phase: "RISK_REVIEW" } & Context)
  | ({ phase: "RISK_BLOCKED" } & Context)
  | ({ phase: "AUTHORIZED"; result: ExecutionResultV1 } & ExecutionContext)
  | ({ phase: "EXECUTING"; result?: ExecutionResultV1 } & ExecutionContext)
  | ({ phase: "COMPLETED"; result: ExecutionResultV1 } & ExecutionContext)
  | ({ phase: "PAUSED"; result: ExecutionResultV1 } & ExecutionContext)
  | ({ phase: "REAPPROVAL_REQUIRED"; result: ExecutionResultV1 } & ExecutionContext)
  | ({ phase: "PARTIALLY_COMPLETED"; result: ExecutionResultV1 } & ExecutionContext)
  | ({ phase: "RECOVERY_PENDING"; executionId: string; requestText: string } & Partial<Pick<Context, "plan" | "goal" | "bundle">>)
  | { phase: "UNAVAILABLE"; requestText: string; kind: "UNSAT" | "POLICY_BLOCKED"; message: string }
  | ({ phase: "EXECUTION_ERROR"; message: string; result?: ExecutionResultV1 } & ExecutionContext)
  | { phase: "ERROR"; requestText?: string; message: string };

export type StateListener = (state: CustomerFlowState) => void;
export type ClarificationAnswer = { reference: string; answer: string };
export type ExecutionResumeRecord = { executionId: string; requestText: string };
export type ExecutionResumeStore = { load(): ExecutionResumeRecord | undefined; save(record: ExecutionResumeRecord): void; clear(): void };
export const ACTIVE_EXECUTION_STORAGE_KEY = "parlance.active-execution.v1";

export function createExecutionResumeStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): ExecutionResumeStore {
  return {
    load() {
      try {
        const raw = storage.getItem(ACTIVE_EXECUTION_STORAGE_KEY); if (!raw) return undefined;
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_RESUME_RECORD");
        const item = value as Record<string, unknown>;
        if (Object.keys(item).some((key) => key !== "executionId" && key !== "requestText") || typeof item.executionId !== "string" || !item.executionId || typeof item.requestText !== "string") throw new Error("INVALID_RESUME_RECORD");
        return { executionId: item.executionId, requestText: item.requestText };
      } catch { try { storage.removeItem(ACTIVE_EXECUTION_STORAGE_KEY); } catch { /* Browser storage is only a recovery convenience. */ } return undefined; }
    },
    save(record) { try { storage.setItem(ACTIVE_EXECUTION_STORAGE_KEY, JSON.stringify(record)); } catch { /* Keep the authorized in-memory flow alive. */ } },
    clear() { try { storage.removeItem(ACTIVE_EXECUTION_STORAGE_KEY); } catch { /* Storage availability cannot change financial truth. */ } },
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : "REQUEST_FAILED"; }
const FINANCIAL_OUTCOME_UNRESOLVED_REASONS = new Set([
  "BANK_RESPONSE_OUTCOME_UNKNOWN", "BANK_LOOKUP_UNAVAILABLE", "RECONCILIATION_CONFLICT",
  "BANK_ACCEPTED_CONFIRMATION_PENDING", "SETTLED_BOOKKEEPING_PENDING",
]);
const DETERMINISTIC_PRE_WRITE_STOP_REASONS = new Set([
  "GOAL_CONSTRAINT_VIOLATION", "FINANCIAL_PLAN_EXPIRED", "FINANCIAL_PLAN_NOT_READY", "MATERIAL_PLAN_CHANGE",
  "BUNDLE_COMPILER_UNAVAILABLE", "TERMINAL_GOAL_CHECK_FAILED", "BUNDLE_REMAINDER_SIMULATION_FAILED",
  "QUOTE_EXPIRED", "FX_QUOTE_INVALID", "FX_UNAVAILABLE", "TRANSFER_RAIL_UNAVAILABLE", "POLICY_BLOCKED",
]);
function hasSettledStep(result: ExecutionResultV1): boolean { return result.steps.some((step) => step.status === "SETTLED"); }
function hasFinanciallyUnresolvedStep(result: ExecutionResultV1): boolean {
  return result.steps.some((step) => {
    if (step.status === "PENDING" || step.status === "ACCEPTED") return true;
    if (step.errorCode && FINANCIAL_OUTCOME_UNRESOLVED_REASONS.has(step.errorCode)) return true;
    if (step.status !== "UNKNOWN") return false;
    return !step.errorCode || !DETERMINISTIC_PRE_WRITE_STOP_REASONS.has(step.errorCode);
  });
}
function isPartial(context: Context, result: ExecutionResultV1): boolean {
  return hasSettledStep(result) && context.plan.steps.some((step) => result.steps.find((item) => item.stepId === step.id)?.status !== "SETTLED");
}

export class CustomerFlowController {
  state: CustomerFlowState;
  private meaningConfirmationInFlight = false;
  private clarificationInFlight = false;
  private statusCheckInFlight: Promise<void> | undefined;
  private executionRunInFlight: Promise<void> | undefined;
  constructor(private readonly api: ParlanceApi, private readonly passkey: PasskeyClient, private readonly listener: StateListener = () => undefined, private readonly resumeStore?: ExecutionResumeStore) {
    this.state = resumeStore ? { phase: "RESTORING_EXECUTION" } : { phase: "COMPOSE" };
  }

  private transition(state: CustomerFlowState): void { this.state = state; this.listener(state); }
  async submitMessage(requestText: string, input?: MessageInputProvenance): Promise<void> {
    if (this.state.phase !== "COMPOSE") throw new Error("INVALID_FLOW_STATE");
    await this.interpret(requestText.trim(), requestText.trim(), input);
  }

  private async interpret(text: string, requestText: string, input?: MessageInputProvenance): Promise<void> {
    if (!text) return;
    this.resumeStore?.clear(); this.transition({ phase: "INTERPRETING", requestText });
    try { this.applyInterpretation(await this.api.sendMessage(text, input), requestText, []); }
    catch (error) { this.transition({ phase: "ERROR", requestText, message: message(error) }); }
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
    const { requestText, clarificationId, answers, bundle } = this.state; this.clarificationInFlight = true;
    try {
      const response = bundle ? await this.api.answerBundleClarification(clarificationId, answer) : await this.api.answerClarification(clarificationId, answer);
      this.applyInterpretation(response, requestText, [...answers, { reference: clarification.originalReference, answer: displayAnswer }]);
    } catch (error) { this.transition({ phase: "ERROR", requestText, message: message(error) }); }
    finally { this.clarificationInFlight = false; }
  }
  private applyInterpretation(response: MessageResponse, requestText: string, answers: ClarificationAnswer[]): void {
    if (response.status === "NEEDS_CLARIFICATION" || response.status === "NEEDS_BUNDLE_CLARIFICATION") this.transition({ phase: "CLARIFICATION", requestText, clarificationId: response.clarificationId, clarifications: response.clarifications, answers, bundle: response.status === "NEEDS_BUNDLE_CLARIFICATION" });
    else if (response.status === "SEMANTIC_VALIDATION_FAILED") this.transition({ phase: "SEMANTIC_VALIDATION_FAILED", requestText, message: response.message });
    else if (response.status === "AWAITING_BUNDLE_CONFIRMATION") this.transition({ phase: "BUNDLE_REVIEW", requestText, candidateId: response.candidateId, candidate: response.goalBundleCandidate, answers });
    else this.transition({ phase: "GOAL_REVIEW", requestText, candidateId: response.candidateId, candidate: response.goalCandidate, answers });
  }

  async confirmMeaning(): Promise<void> {
    if (this.meaningConfirmationInFlight) return;
    if (!(this.state.phase === "GOAL_REVIEW" || this.state.phase === "GOAL_CONFIRMATION_FAILED" || this.state.phase === "BUNDLE_REVIEW" || this.state.phase === "BUNDLE_CONFIRMATION_FAILED")) throw new Error("INVALID_FLOW_STATE");
    const { candidateId, candidate, requestText } = this.state; const bundleFlow = "items" in candidate; this.meaningConfirmationInFlight = true;
    if (bundleFlow) this.transition({ phase: "CONFIRMING_BUNDLE", requestText, candidate }); else this.transition({ phase: "CONFIRMING_GOAL", requestText, candidate });
    try {
      if (bundleFlow) {
        let bundle: GoalBundleContractV1;
        try { bundle = await this.api.confirmGoalBundle(candidateId); } catch (error) { this.transition({ phase: "BUNDLE_CONFIRMATION_FAILED", requestText, candidateId, candidate, message: message(error) }); return; }
        this.transition({ phase: "COMPILING_BUNDLE", requestText, bundle });
        try {
          const result = await this.api.compileGoalBundle(bundle.bundleId);
          if ("financialPlan" in result) this.transition({ phase: "PLAN_REVIEW", requestText, bundle, plan: result.financialPlan });
          else if (result.status !== "SAT") this.transition({ phase: "UNAVAILABLE", requestText, kind: result.status, message: result.reason.message });
          else throw new Error("BUNDLE_COMPILER_RESPONSE_INVALID");
        } catch (error) { this.transition({ phase: "ERROR", requestText, message: message(error) }); }
      } else {
        let goal: GoalContractV1;
        try { goal = await this.api.confirmGoal(candidateId); } catch (error) { this.transition({ phase: "GOAL_CONFIRMATION_FAILED", requestText, candidateId, candidate, message: message(error) }); return; }
        this.transition({ phase: "COMPILING", requestText, goal });
        try {
          const result = await this.api.compileGoal(goal.id);
          if (result.status === "SAT") this.transition({ phase: "PLAN_REVIEW", requestText, goal, plan: result.plan });
          else this.transition({ phase: "UNAVAILABLE", requestText, kind: result.status, message: result.reason.message });
        } catch (error) { this.transition({ phase: "ERROR", requestText, message: message(error) }); }
      }
    } finally { this.meaningConfirmationInFlight = false; }
  }

  async authorizeAndExecute(): Promise<void> {
    if (!(this.state.phase === "PLAN_REVIEW" || this.state.phase === "PASSKEY_CANCELLED" || this.state.phase === "APPROVAL_FAILED")) throw new Error("INVALID_FLOW_STATE");
    const context = contextFrom(this.state); this.transition({ phase: "AUTHORIZING", ...context }); let executionId: string;
    try {
      const issued = await this.api.approvalOptions(context.plan.id); const credential = await this.passkey.request(issued.options);
      const authorized = await this.api.verifyApproval(context.plan.id, issued.challengeId, credential); executionId = authorized.execution.executionId;
    } catch (error) {
      const code = message(error);
      if (code === "FINANCIAL_PLAN_EXPIRED") await this.refreshExpiredPlan(context);
      else if (code === "RISK_REVIEW_REQUIRED") this.transition({ phase: "RISK_REVIEW", ...context });
      else if (code === "RISK_BLOCKED") this.transition({ phase: "RISK_BLOCKED", ...context });
      else if (code === "PASSKEY_CREDENTIAL_NOT_FOUND") this.transition({ phase: "PASSKEY_REQUIRED", ...context });
      else if (error instanceof PasskeyCancelledError) this.transition({ phase: "PASSKEY_CANCELLED", ...context });
      else this.transition({ phase: "APPROVAL_FAILED", ...context, message: code });
      return;
    }
    try { this.resumeStore?.save({ executionId, requestText: context.requestText }); } catch { /* Authorization already succeeded; storage is best-effort only. */ }
    await this.runExistingExecution({ ...context, executionId });
  }

  private runExistingExecution(context: ExecutionContext): Promise<void> {
    if (this.executionRunInFlight) return this.executionRunInFlight;
    this.executionRunInFlight = (async () => {
      this.transition({ phase: "EXECUTING", ...context });
      try {
        const result = await this.api.runExecution(context.executionId);
        if (result.status === "COMPLETED") this.transition({ phase: "COMPLETED", ...context, result });
        else if (result.status === "FAILED") this.applyFailedResult(context, result);
        else if (result.status === "UNKNOWN") await this.readAuthoritativeDetail(context.executionId, context.requestText, context);
        else this.transition({ phase: "EXECUTING", ...context, result });
      } catch { await this.readAuthoritativeDetail(context.executionId, context.requestText, context); }
    })().finally(() => { this.executionRunInFlight = undefined; });
    return this.executionRunInFlight;
  }

  async continueAuthorizedExecution(): Promise<void> {
    if (this.state.phase !== "AUTHORIZED") throw new Error("INVALID_FLOW_STATE");
    await this.runExistingExecution({ ...contextFrom(this.state), executionId: this.state.executionId });
  }
  async resumeActiveExecution(): Promise<void> {
    if (this.statusCheckInFlight) return this.statusCheckInFlight;
    if (this.state.phase !== "RESTORING_EXECUTION") return;
    let record: ExecutionResumeRecord | undefined;
    try { record = this.resumeStore?.load(); } catch { record = undefined; }
    if (!record) { this.transition({ phase: "COMPOSE" }); return; }
    this.statusCheckInFlight = this.readAuthoritativeDetail(record.executionId, record.requestText).finally(() => { this.statusCheckInFlight = undefined; });
    return this.statusCheckInFlight;
  }
  async checkExecutionStatus(): Promise<void> {
    if (this.statusCheckInFlight) return this.statusCheckInFlight;
    if (!(this.state.phase === "RECOVERY_PENDING" || this.state.phase === "EXECUTING" || this.state.phase === "PAUSED" || this.state.phase === "AUTHORIZED")) throw new Error("INVALID_FLOW_STATE");
    const { executionId, requestText } = this.state;
    const fallback = "plan" in this.state && this.state.plan && (("goal" in this.state && this.state.goal) || ("bundle" in this.state && this.state.bundle)) ? contextFrom(this.state as Extract<CustomerFlowState, { plan: FinancialPlanV1 }>) : undefined;
    this.statusCheckInFlight = this.readAuthoritativeDetail(executionId, requestText, fallback).finally(() => { this.statusCheckInFlight = undefined; });
    return this.statusCheckInFlight;
  }
  private async readAuthoritativeDetail(executionId: string, requestText: string, fallback?: Context): Promise<void> {
    try {
      const detail = await this.api.executionDetail(executionId);
      if (detail.result.executionId !== executionId || detail.result.planId !== detail.plan.id) throw new Error("EXECUTION_DETAIL_MISMATCH");
      const context: Context = "goalBundle" in detail ? { requestText, bundle: detail.goalBundle, plan: detail.plan } : { requestText, goal: detail.goal, plan: detail.plan };
      this.applyExecutionDetail({ ...context, executionId }, detail);
    } catch {
      if (fallback) this.transition({ phase: "RECOVERY_PENDING", ...fallback, executionId });
      else this.transition({ phase: "RECOVERY_PENDING", executionId, requestText });
    }
  }
  private applyExecutionDetail(context: ExecutionContext, detail: ExecutionDetail): void {
    const { result } = detail;
    if (detail.state === "COMPLETED" || result.status === "COMPLETED") { this.transition({ phase: "COMPLETED", ...context, result }); return; }
    if (isPartial(context, result)) {
      if (hasFinanciallyUnresolvedStep(result)) this.transition({ phase: "PAUSED", ...context, result });
      else this.transition({ phase: "PARTIALLY_COMPLETED", ...context, result });
      return;
    }
    if (detail.state === "REAPPROVAL_REQUIRED") { this.transition({ phase: "REAPPROVAL_REQUIRED", ...context, result }); return; }
    if (detail.state === "PAUSED") { this.transition({ phase: "PAUSED", ...context, result }); return; }
    if (detail.state === "EXECUTING") { this.transition({ phase: "EXECUTING", ...context, result }); return; }
    if (detail.state === "AUTHORIZED") { this.transition({ phase: "AUTHORIZED", ...context, result }); return; }
    this.applyFailedResult(context, result);
  }
  private applyFailedResult(context: ExecutionContext, result: ExecutionResultV1): void {
    if (isPartial(context, result)) this.transition({ phase: "PARTIALLY_COMPLETED", ...context, result });
    else this.transition({ phase: "EXECUTION_ERROR", ...context, result, message: result.goalOutcome.summary });
  }

  async reviewUpdatedPlan(): Promise<void> {
    if (this.state.phase !== "REAPPROVAL_REQUIRED" || hasSettledStep(this.state.result)) throw new Error("INVALID_FLOW_STATE");
    await this.refreshExpiredPlan(contextFrom(this.state), true);
  }
  async passkeyEnrolled(): Promise<void> {
    if (this.state.phase !== "PASSKEY_REQUIRED") throw new Error("INVALID_FLOW_STATE");
    const context = contextFrom(this.state); const validUntil = context.plan.validity.validUntil;
    if (validUntil !== undefined && Date.now() >= Date.parse(validUntil)) { await this.refreshExpiredPlan(context); return; }
    this.transition({ phase: "PLAN_REVIEW", ...context, passkeyReady: true });
  }
  private async refreshExpiredPlan(context: Context, clearRecovery = false): Promise<void> {
    if ("bundle" in context) this.transition({ phase: "COMPILING_BUNDLE", requestText: context.requestText, bundle: context.bundle }); else this.transition({ phase: "COMPILING", requestText: context.requestText, goal: context.goal });
    try {
      if ("bundle" in context) {
        const result = await this.api.compileGoalBundle(context.bundle.bundleId);
        if ("financialPlan" in result) { if (clearRecovery) this.resumeStore?.clear(); this.transition({ phase: "PLAN_REVIEW", requestText: context.requestText, bundle: context.bundle, plan: result.financialPlan, refreshed: true }); }
        else if (result.status !== "SAT") this.transition({ phase: "UNAVAILABLE", requestText: context.requestText, kind: result.status, message: result.reason.message }); else throw new Error("BUNDLE_COMPILER_RESPONSE_INVALID");
      } else {
        const result = await this.api.compileGoal(context.goal.id);
        if (result.status === "SAT") { if (clearRecovery) this.resumeStore?.clear(); this.transition({ phase: "PLAN_REVIEW", requestText: context.requestText, goal: context.goal, plan: result.plan, refreshed: true }); }
        else this.transition({ phase: "UNAVAILABLE", requestText: context.requestText, kind: result.status, message: result.reason.message });
      }
    } catch (error) { this.transition({ phase: "ERROR", requestText: context.requestText, message: message(error) }); }
  }
  reset(): void { this.resumeStore?.clear(); this.transition({ phase: "COMPOSE" }); }
}

function contextFrom(state: Extract<CustomerFlowState, { plan: FinancialPlanV1 }>): Context {
  return "bundle" in state && state.bundle ? { requestText: state.requestText, bundle: state.bundle, plan: state.plan } : { requestText: state.requestText, goal: state.goal!, plan: state.plan };
}
