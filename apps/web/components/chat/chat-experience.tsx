"use client";

import type { CustomerFlowState } from "../../lib/customer-flow";
import { presentGoal, presentPlan, type PlanPresentation } from "../../lib/customer-presentation";
import { customerExecutionMessage } from "../../lib/customer-safety-copy";
import { useCustomerFlow } from "../../hooks/use-customer-flow";
import { ExecutionTimeline, type TimelineItem } from "../execution/execution-timeline";
import { ReapprovalCard } from "../execution/reapproval-card";
import { SafeStopCard } from "../execution/safe-stop-card";
import { ClarificationCard } from "../goal/clarification-card";
import { UnderstoodGoalCard } from "../goal/understood-goal-card";
import { FinancialPlanPreview } from "../plan/financial-plan-preview";
import { PasskeySetupCard } from "../security/passkey-setup-card";
import { Icon } from "../ui/icon";
import { ConversationComposer } from "./conversation-composer";

function requestText(state: CustomerFlowState): string | undefined { return "requestText" in state ? state.requestText : undefined; }
function statusFor(stepId: string, state: CustomerFlowState): TimelineItem["status"] {
  if (!("result" in state) || !state.result) return state.phase === "EXECUTING" ? "active" : "waiting";
  const step = state.result.steps.find((item) => item.stepId === stepId);
  if (step?.status === "SETTLED") return "complete";
  if (step?.status === "PENDING" || step?.status === "ACCEPTED") return "active";
  if (step?.status === "FAILED") return "stopped";
  return "paused";
}
function executionTimeline(presentation: PlanPresentation, state: CustomerFlowState): TimelineItem[] {
  const finished = state.phase === "COMPLETED";
  return [
    { label: "Latest account state checked", detail: "Balances and availability were checked", status: "complete" },
    { label: "Approved route verified", detail: "Only the exact passkey-approved route can continue", status: finished ? "complete" : state.phase === "EXECUTING" ? "active" : "complete" },
    ...presentation.steps.map((step) => ({ label: step.title, detail: step.summary, status: statusFor(step.id, state) })),
    { label: "Confirmed with bank", detail: finished ? "Bank confirmation received" : "Waiting for final bank confirmation", status: finished ? "complete" : state.phase === "EXECUTION_ERROR" ? "stopped" : "waiting" },
  ];
}

export function ChatExperience() {
  const flow = useCustomerFlow(); const { state } = flow; const message = requestText(state); const isInitial = state.phase === "COMPOSE";
  const planPresentation = "goal" in state && "plan" in state ? presentPlan(state.goal, state.plan) : undefined;
  return <div className={`parlance-workspace ${isInitial ? "is-initial" : "is-active"}`}>
    <header className="workspace-header"><div className="workspace-title"><span className="parlance-symbol"><Icon name="spark" /></span><div><p>{isInitial ? "Parlance" : "Active request"}</p><h1>{isInitial ? "Tell us the outcome you want." : "Parlance"}</h1></div></div>{isInitial && <span className="workspace-security"><Icon name="shield" />Inside digibank</span>}</header>
    <div className="workspace-body">
      {isInitial && <div className="workspace-intro"><h2>What would you like to do?</h2><p>AI helps understand your request. Banking systems decide how it can be completed safely.</p></div>}
      {isInitial && <ConversationComposer onSubmit={(text) => void flow.submitMessage(text)} />}
      {message && <div className="conversation-stream">
        <div className="request-context"><span className="request-context-icon"><Icon name="spark" /></span><div><small>Your request</small><strong>{message}</strong></div><button type="button" onClick={flow.reset}>Start over <Icon name="arrow" /></button></div>
        {state.phase === "INTERPRETING" && <WorkingState title="Understanding your request…" detail="Checking names and details against your available banking relationships." />}
        {state.phase === "CLARIFICATION" && state.clarifications[0] && <ClarificationCard clarification={state.clarifications[0]} onCancel={flow.reset} onSelect={(option) => void flow.answerClarification(state.clarifications[0]!, option)} />}
        {state.phase === "GOAL_REVIEW" && <UnderstoodGoalCard goal={presentGoal(state.candidate)} onEdit={flow.reset} onConfirm={() => void flow.confirmMeaning()} />}
        {state.phase === "GOAL_CONFIRMATION_FAILED" && <><UnderstoodGoalCard goal={presentGoal(state.candidate)} onEdit={flow.reset} onConfirm={() => void flow.confirmMeaning()} /><InlineNotice title="Meaning confirmation could not be recorded" detail="No plan was created. Review the meaning and try again when ready." /></>}
        {state.phase === "CONFIRMING_GOAL" && <WorkingState title="Confirming what you mean…" detail="Your confirmation is being recorded before any transaction plan is created." />}
        {state.phase === "COMPILING" && <CompilingState />}
        {state.phase === "UNAVAILABLE" && <OutcomeCard title={state.kind === "POLICY_BLOCKED" ? "Cannot currently be completed safely" : "This goal cannot currently be completed"} detail={state.kind === "POLICY_BLOCKED" ? customerExecutionMessage(undefined, "POLICY_BLOCKED") : state.message} onDone={flow.reset} />}
        {planPresentation && state.phase === "PLAN_REVIEW" && <>{state.refreshed && <InlineNotice title="Plan refreshed" detail="This plan was refreshed because its quote expired. Please review it again." />}{state.passkeyReady && <InlineNotice title="Passkey ready" detail="Review this exact plan, then confirm it with your passkey." />}<FinancialPlanPreview scenario={planPresentation} onCancel={flow.reset} onApprove={() => void flow.authorizeAndExecute()} /></>}
        {planPresentation && state.phase === "PASSKEY_REQUIRED" && <><FinancialPlanPreview scenario={planPresentation} onCancel={flow.reset} onApprove={() => undefined} busy /><PasskeySetupCard transaction onReady={() => void flow.passkeyEnrolled()} /></>}
        {planPresentation && state.phase === "AUTHORIZING" && <><FinancialPlanPreview scenario={planPresentation} onCancel={() => undefined} onApprove={() => undefined} busy /><WorkingState title="Confirm with your passkey" detail="Your bank is verifying approval for this exact plan." /></>}
        {planPresentation && state.phase === "PASSKEY_CANCELLED" && <><FinancialPlanPreview scenario={planPresentation} onCancel={flow.reset} onApprove={() => void flow.authorizeAndExecute()} /><InlineNotice title="Passkey confirmation was cancelled" detail="Nothing was authorized or executed. You can try again when ready." /></>}
        {planPresentation && state.phase === "APPROVAL_FAILED" && <><FinancialPlanPreview scenario={planPresentation} onCancel={flow.reset} onApprove={() => void flow.authorizeAndExecute()} /><InlineNotice title="Approval could not be verified" detail="Nothing was executed. Review the plan and try passkey confirmation again." /></>}
        {planPresentation && state.phase === "EXECUTING" && <ExecutionTimeline items={executionTimeline(planPresentation, state)} steps={planPresentation.steps} scenario={planPresentation} />}
        {planPresentation && state.phase === "COMPLETED" && <><ExecutionTimeline items={executionTimeline(planPresentation, state)} steps={planPresentation.steps} scenario={planPresentation} /><div className="completion-action"><button type="button" className="button bank-primary" onClick={flow.reset}>Done</button></div></>}
        {planPresentation && state.phase === "PAUSED" && <SafeStopCard scenario={planPresentation} result={state.result} onDone={flow.reset} onStartOver={flow.reset} />}
        {planPresentation && state.phase === "REAPPROVAL_REQUIRED" && <ReapprovalCard scenario={planPresentation} onCancel={flow.reset} onStartOver={flow.reset} />}
        {state.phase === "EXECUTION_ERROR" && <OutcomeCard title="Execution error" detail="Your request did not complete. No further action will be attempted without a new review." onDone={flow.reset} />}
        {state.phase === "ERROR" && <OutcomeCard title="We couldn’t continue this request" detail="No money was moved. Please try again." onDone={flow.reset} />}
      </div>}
    </div>
  </div>;
}

function WorkingState({ title, detail }: { title: string; detail: string }) { return <section className="product-card compiling-card" aria-live="polite"><div className="compiler-orbit" aria-hidden="true"><span /><i /></div><h2>{title}</h2><p className="card-description">{detail}</p></section>; }
function CompilingState() { return <section className="product-card compiling-card" aria-live="polite"><div className="compiler-orbit" aria-hidden="true"><span /><i /></div><p className="eyebrow">Your confirmed goal</p><h2>Finding a safe route…</h2><p className="card-description">Latest account state is being checked before deterministic banking systems construct a valid route.</p><div className="compile-checks"><span className="done">✓ <strong>Meaning confirmed</strong></span><span className="active"><i /> Checking latest account state</span><span><i /> Constructing a valid route</span></div><p className="trust-note"><Icon name="shield" /> The conversational layer does not create transaction steps.</p></section>; }
function InlineNotice({ title, detail }: { title: string; detail: string }) { return <section className="product-card"><h2>{title}</h2><p className="card-description">{detail}</p></section>; }
function OutcomeCard({ title, detail, onDone }: { title: string; detail: string; onDone(): void }) { return <section className="product-card safe-stop-card"><div className="safe-stop-symbol"><Icon name="shield" /></div><h2>{title}</h2><p className="card-description">{detail}</p><div className="card-actions"><button className="button bank-primary" type="button" onClick={onDone}>Done</button></div></section>; }
