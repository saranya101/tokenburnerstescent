"use client";

import type { CustomerFlowState } from "../../lib/customer-flow";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { presentBundle, presentBundlePlan, presentGoal, presentPlan, type PlanPresentation } from "../../lib/customer-presentation";
import { customerExecutionMessage } from "../../lib/customer-safety-copy";
import { balancesByCurrency, formatMinorUnits } from "../../lib/banking-state";
import { useCustomerFlow } from "../../hooks/use-customer-flow";
import { useBankingState } from "../../hooks/use-banking-state";
import { ExecutionTimeline, type TimelineItem } from "../execution/execution-timeline";
import { PartialCompletionCard } from "../execution/partial-completion-card";
import { ReapprovalCard } from "../execution/reapproval-card";
import { RecoveryStatusCard } from "../execution/recovery-status-card";
import { SafeStopCard } from "../execution/safe-stop-card";
import { ClarificationCard } from "../goal/clarification-card";
import { UnderstoodGoalCard } from "../goal/understood-goal-card";
import { UnderstoodBundleCard } from "../goal/understood-bundle-card";
import { FinancialPlanPreview } from "../plan/financial-plan-preview";
import { InvestmentFundingCard } from "../plan/investment-funding-card";
import { ProtectedBalanceRefusalCard, protectedBalanceFigures } from "../plan/protected-balance-refusal-card";
import { RiskOutcomeCard } from "../risk/risk-outcome-card";
import { PasskeySetupCard } from "../security/passkey-setup-card";
import { Icon } from "../ui/icon";
import { ChatBankingSidebarView } from "./chat-banking-sidebar";
import { ConversationComposer } from "./conversation-composer";
import { FinancialTrustJourney } from "./financial-trust-journey";
import { SingaporeSkyline } from "./singapore-skyline";

export const chatWelcomeGreeting = "Welcome back.";

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
  const investment = isInvestmentPresentation(presentation);
  return [
    { label: "Latest account state checked", detail: "Balances and availability were checked", status: "complete" },
    { label: `${investment ? "Investment" : "Payment"} approval checked`, detail: `Your passkey approval matches these ${investment ? "investment" : "payment"} details`, status: finished ? "complete" : state.phase === "EXECUTING" ? "active" : "complete" },
    ...presentation.steps.map((step) => ({ label: step.title, detail: step.summary, status: statusFor(step.id, state) })),
    { label: "Confirmed with bank", detail: finished ? "Bank confirmation received" : "Waiting for final bank confirmation", status: finished ? "complete" : state.phase === "EXECUTION_ERROR" ? "stopped" : "waiting" },
  ];
}

function candidateIncludesInvestment(candidate: Extract<CustomerFlowState, { phase: "GOAL_REVIEW" | "GOAL_CONFIRMATION_FAILED" | "BUNDLE_REVIEW" | "BUNDLE_CONFIRMATION_FAILED" | "CONFIRMING_GOAL" | "CONFIRMING_BUNDLE" }>["candidate"]): boolean {
  return "goal" in candidate ? candidate.goal.type === "ACQUIRE_ASSET" : candidate.items.some((item) => item.goal.type === "ACQUIRE_ASSET");
}

function isInvestmentState(state: CustomerFlowState): boolean {
  if (state.phase === "CLARIFICATION") return state.clarifications.some((item) => item.field.includes("assetReference") || item.options.some((option) => option.entityType === "ASSET"));
  if ("candidate" in state) return candidateIncludesInvestment(state.candidate);
  if ("goal" in state && state.goal) return state.goal.goal.type === "ACQUIRE_ASSET";
  if ("bundle" in state && state.bundle) return state.bundle.items.some((item) => item.goal.type === "ACQUIRE_ASSET");
  return false;
}

function hasKnownGoalType(state: CustomerFlowState): boolean {
  return "candidate" in state || ("goal" in state && state.goal !== undefined) || ("bundle" in state && state.bundle !== undefined);
}

function isInvestmentPresentation(presentation: PlanPresentation): boolean {
  return presentation.goal.details.some((item) => item.label === "Investment");
}

export function ChatExperience({ initialRequest = "" }: { initialRequest?: string }) {
  const flow = useCustomerFlow(); const { state } = flow; const message = requestText(state); const isInitial = state.phase === "COMPOSE";
  const banking = useBankingState(); const investment = isInvestmentState(state);
  const refreshedExecution = useRef<string | undefined>(undefined);
  const refreshedPlan = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (state.phase === "COMPLETED" && refreshedExecution.current !== state.result.executionId) {
      refreshedExecution.current = state.result.executionId;
      void banking.refresh();
    }
  }, [state, banking.refresh]);
  useEffect(() => {
    if (state.phase === "PLAN_REVIEW" && refreshedPlan.current !== state.plan.id) {
      refreshedPlan.current = state.plan.id;
      void banking.refresh();
    }
  }, [state, banking.refresh]);
  const knownGoalType = hasKnownGoalType(state);
  const usdAvailable = banking.state ? balancesByCurrency(banking.state).find((balance) => balance.currency === "USD") : undefined;
  const unavailableDetail = state.phase === "UNAVAILABLE" && investment && state.reasonCode === "INSUFFICIENT_FUNDS"
    ? `${state.message} ${usdAvailable ? `Your current available USD balance is ${formatMinorUnits("USD", usdAvailable.availableMinorUnits)}.` : banking.loading ? "We’re checking your current available USD balance." : "Your current USD balance is temporarily unavailable."}`
    : state.phase === "UNAVAILABLE" ? state.kind === "POLICY_BLOCKED" ? customerExecutionMessage(undefined, "POLICY_BLOCKED") : state.message : undefined;
  const unresolved = state.phase === "RECOVERY_PENDING" || state.phase === "EXECUTING" || state.phase === "PAUSED" || state.phase === "AUTHORIZED";
  const fxQuoteDetailsReady = !("plan" in state) || !state.plan.steps.some((step) => step.action === "FX_CONVERT") || Boolean(
    banking.state?.stateVersion === state.plan.bankStateVersion
    && state.plan.steps.filter((step) => step.action === "FX_CONVERT").every((step) => banking.state?.fxQuotes.some((quote) => quote.id === step.parameters.quoteId)),
  );
  const planPresentation = "plan" in state ? ("bundle" in state ? presentBundlePlan(state.bundle, state.plan, banking.state) : "goal" in state ? presentPlan(state.goal, state.plan, banking.state) : undefined) : undefined;
  return <div className={`parlance-workspace ${isInitial ? "is-initial" : "is-active"}`}>
    <div className="chat-workspace-grid">
      <section className="chat-primary" aria-label="Pay and transfer conversation">
    <header className="workspace-header"><div className="workspace-title"><div><p>{isInitial ? chatWelcomeGreeting : investment ? "Investments" : knownGoalType ? "Pay & Transfer" : "Your request"}</p><h1>{isInitial ? "What would you like to do today?" : investment ? "Your investment request" : knownGoalType ? "Your payment request" : "Reviewing your request"}</h1>{isInitial && <span>Tell me what you&apos;d like to achieve. You&apos;ll review the exact plan before anything moves.</span>}</div></div>{isInitial && <Link className="workspace-payees-link" href="/payees"><Icon name="recipient" /> Saved payees</Link>}</header>
    <div className="workspace-body">
      {state.phase === "RESTORING_EXECUTION" && <WorkingState title="Checking your latest transaction status…" detail="Please wait while we check whether a recent transaction still needs your attention." />}
      {isInitial && <><section className="parlance-introduction"><span><Icon name="spark" /></span><div><strong>Parlance</strong><p>Describe what you need in your own words. I’ll confirm the meaning first, then show the exact banking plan for your review.</p></div></section><ConversationComposer initialValue={state.draftText ?? initialRequest} onSubmit={(text, input) => void flow.submitMessage(text, input)} /></>}
      {message && <div className="conversation-stream">
        <div className="request-context"><span className="request-context-icon"><Icon name="transfer" /></span><div><small>Your request</small><strong>“{message}”</strong></div>{!unresolved && state.phase !== "PARTIALLY_COMPLETED" && <button type="button" onClick={flow.reset}>Start over <Icon name="arrow" /></button>}</div>
        <FinancialTrustJourney state={state} />
        {state.phase === "INTERPRETING" && <WorkingState title="Understanding your request…" detail="Checking names and details against your available banking relationships." />}
        {state.phase === "CLARIFICATION" && state.clarifications[0] && <ClarificationCard clarification={state.clarifications[0]} beneficiaries={banking.state?.beneficiaries ?? []} {...(state.submitting === undefined ? {} : { busy: state.submitting })} {...(state.error === undefined ? {} : { error: state.error })} onCancel={flow.reset} onSelect={(option) => void flow.answerClarification(state.clarifications[0]!, option)} onAnswerText={(answer) => void flow.answerClarificationText(state.clarifications[0]!, answer)} />}
        {state.phase === "SEMANTIC_VALIDATION_FAILED" && <OutcomeCard title="Please clarify your request" detail={state.message} onDone={flow.reset} />}
        {state.phase === "GOAL_REVIEW" && <>{state.answers.map((answer) => <InlineNotice key={`${answer.reference}:${answer.answer}`} title={`You clarified “${answer.reference}”`} detail={answer.answer} />)}<UnderstoodGoalCard goal={presentGoal(state.candidate, new Map(state.answers.map((answer) => [answer.reference, answer.answer])))} onEdit={flow.reset} onConfirm={() => void flow.confirmMeaning()} /></>}
        {state.phase === "BUNDLE_REVIEW" && <>{state.answers.map((answer) => <InlineNotice key={`${answer.reference}:${answer.answer}`} title={`You clarified “${answer.reference}”`} detail={answer.answer} />)}<UnderstoodBundleCard bundle={presentBundle(state.candidate)} onEdit={flow.reset} onConfirm={() => void flow.confirmMeaning()} /></>}
        {state.phase === "GOAL_CONFIRMATION_FAILED" && <><UnderstoodGoalCard goal={presentGoal(state.candidate)} onEdit={flow.reset} onConfirm={() => void flow.confirmMeaning()} /><InlineNotice title="Meaning confirmation could not be recorded" detail="No plan was created. Review the meaning and try again when ready." /></>}
        {state.phase === "BUNDLE_CONFIRMATION_FAILED" && <><UnderstoodBundleCard bundle={presentBundle(state.candidate)} onEdit={flow.reset} onConfirm={() => void flow.confirmMeaning()} /><InlineNotice title="Meaning confirmation could not be recorded" detail="No plan was created. Review the combined meaning and try again when ready." /></>}
        {state.phase === "CONFIRMING_GOAL" && <WorkingState title="Confirming what you mean…" detail="Your confirmation is being recorded before any transaction plan is created." />}
        {state.phase === "CONFIRMING_BUNDLE" && <WorkingState title="Confirming your combined request…" detail="Your confirmation is being recorded before any transaction plan is created." />}
        {state.phase === "COMPILING" && <CompilingState investment={investment} />}
        {state.phase === "COMPILING_BUNDLE" && <CompilingState investment={investment} />}
        {state.phase === "UNAVAILABLE" && investment && state.reasonCode === "INSUFFICIENT_FUNDS" && <InvestmentFundingCard state={banking.state} loading={banking.loading} error={banking.error} usdAvailableMinorUnits={usdAvailable?.availableMinorUnits} onReview={(sourceAccountId, reserve) => void flow.reviewInvestmentFunding(sourceAccountId, reserve)} onNotNow={flow.reset} />}
        {state.phase === "UNAVAILABLE" && state.goal && state.reasonCode === "MIN_AVAILABLE_BALANCE_VIOLATED" && protectedBalanceFigures(state.goal, state.details, banking.state) && <ProtectedBalanceRefusalCard goal={state.goal} details={state.details} {...(banking.state ? { state: banking.state } : {})} onAmend={flow.amendRequest} onStartOver={flow.reset} />}
        {state.phase === "UNAVAILABLE" && !(investment && state.reasonCode === "INSUFFICIENT_FUNDS") && !(state.goal && state.reasonCode === "MIN_AVAILABLE_BALANCE_VIOLATED" && protectedBalanceFigures(state.goal, state.details, banking.state)) && <OutcomeCard title={investment ? "We can’t complete this investment right now" : "We can’t complete this payment right now"} detail={unavailableDetail!} onDone={flow.reset} />}
        {planPresentation && state.phase === "PLAN_REVIEW" && <>{state.refreshed && <InlineNotice title={`${investment ? "Investment" : "Payment"} details refreshed`} detail={`Some details changed while you were reviewing this ${investment ? "investment" : "payment"}. Please review the updated ${investment ? "investment" : "payment"} before continuing.`} />}{state.passkeyReady && <InlineNotice title="Passkey ready" detail={`Review these ${investment ? "investment" : "payment"} details, then confirm with your passkey.`} />}{!fxQuoteDetailsReady && <InlineNotice title="Checking the latest conversion quote" detail={banking.loading ? "Approval will be available after the exact exchange rate and fee are displayed." : "The current banking state no longer matches this plan. Start over to prepare a new quote before approval."} />}<FinancialPlanPreview scenario={planPresentation} onCancel={flow.reset} onApprove={() => void flow.authorizeAndExecute()} reviewReady={fxQuoteDetailsReady} /></>}
        {planPresentation && state.phase === "PASSKEY_REQUIRED" && <><FinancialPlanPreview scenario={planPresentation} onCancel={flow.reset} onApprove={() => undefined} busy /><PasskeySetupCard transaction onReady={() => void flow.passkeyEnrolled()} /></>}
        {planPresentation && state.phase === "AUTHORIZING" && <><FinancialPlanPreview scenario={planPresentation} onCancel={() => undefined} onApprove={() => undefined} busy /><WorkingState title="Confirm with your passkey" detail="Your bank is verifying approval for this exact plan." /></>}
        {planPresentation && state.phase === "PASSKEY_CANCELLED" && <><FinancialPlanPreview scenario={planPresentation} onCancel={flow.reset} onApprove={() => void flow.authorizeAndExecute()} /><InlineNotice title="Passkey confirmation was cancelled" detail="Nothing was authorized or executed. You can try again when ready." /></>}
        {planPresentation && state.phase === "APPROVAL_FAILED" && <><FinancialPlanPreview scenario={planPresentation} onCancel={flow.reset} onApprove={() => void flow.authorizeAndExecute()} /><InlineNotice title="Approval could not be verified" detail="Nothing was executed. Review the plan and try passkey confirmation again." /></>}
        {state.phase === "RISK_REVIEW" && <RiskOutcomeCard decision="REVIEW" onDone={flow.reset} />}
        {state.phase === "RISK_BLOCKED" && <RiskOutcomeCard decision="BLOCK" onDone={flow.reset} />}
        {planPresentation && state.phase === "AUTHORIZED" && <RecoveryCard title="Your approved transaction is ready" detail="This is the same transaction you already approved. Continue when you’re ready." action="Continue transaction" onAction={() => void flow.continueAuthorizedExecution()} />}
        {planPresentation && state.phase === "EXECUTING" && <><ExecutionTimeline items={executionTimeline(planPresentation, state)} steps={planPresentation.steps} scenario={planPresentation} /><div className="completion-action"><button className="button bank-primary" type="button" onClick={() => void flow.checkExecutionStatus()}>Check status</button></div></>}
        {planPresentation && state.phase === "COMPLETED" && <><ExecutionTimeline items={executionTimeline(planPresentation, state)} steps={planPresentation.steps} scenario={planPresentation} currentState={banking.state?.stateVersion === state.result.finalStateVersion ? banking.state : undefined} reference={state.result.executionId} /><div className="completion-action"><button className="button bank-primary" type="button" onClick={flow.reset}>Done</button></div></>}
        {planPresentation && state.phase === "PAUSED" && <SafeStopCard scenario={planPresentation} result={state.result} onDone={flow.reset} onStartOver={flow.reset} onCheckStatus={() => void flow.checkExecutionStatus()} />}
        {planPresentation && state.phase === "PARTIALLY_COMPLETED" && <PartialCompletionCard scenario={planPresentation} result={state.result} onDone={flow.reset} />}
        {planPresentation && state.phase === "REAPPROVAL_REQUIRED" && <ReapprovalCard scenario={planPresentation} onCancel={flow.reset} onReview={() => void flow.reviewUpdatedPlan()} />}
        {state.phase === "RECOVERY_PENDING" && <RecoveryStatusCard onCheckStatus={() => void flow.checkExecutionStatus()} />}
        {state.phase === "EXECUTION_ERROR" && <OutcomeCard title="Execution error" detail="Your request did not complete. No further action will be attempted without a new review." onDone={flow.reset} />}
        {state.phase === "ERROR" && <OutcomeCard title="We couldn’t continue this request" detail="No money was moved. Please try again." onDone={flow.reset} />}
      </div>}
    </div>
      </section>
      <ChatBankingSidebarView {...banking} />
    </div>
    {isInitial && <div className="chat-skyline-scene"><SingaporeSkyline /></div>}
  </div>;
}

function WorkingState({ title, detail }: { title: string; detail: string }) { return <section className="product-card compiling-card" aria-live="polite"><div className="compiler-orbit" aria-hidden="true"><span /><i /></div><h2>{title}</h2><p className="card-description">{detail}</p></section>; }
function CompilingState({ investment }: { investment: boolean }) { const noun = investment ? "investment" : "payment"; return <section className="product-card compiling-card" aria-live="polite"><div className="compiler-orbit" aria-hidden="true"><span /><i /></div><p className="eyebrow">Request confirmed</p><h2>Preparing your {noun} details…</h2><p className="card-description">We’re checking your latest account information before showing you exactly what will happen.</p><div className="compile-checks"><span className="done">✓ <strong>Request understood</strong></span><span className="active"><i /> Checking latest account information</span><span><i /> Preparing {noun} details</span></div></section>; }
function InlineNotice({ title, detail }: { title: string; detail: string }) { return <section className="product-card"><h2>{title}</h2><p className="card-description">{detail}</p></section>; }
function OutcomeCard({ title, detail, onDone }: { title: string; detail: string; onDone(): void }) { return <section className="product-card safe-stop-card"><div className="safe-stop-symbol"><Icon name="shield" /></div><h2>{title}</h2><p className="card-description">{detail}</p><div className="card-actions"><button className="button bank-primary" type="button" onClick={onDone}>Done</button></div></section>; }
function RecoveryCard({ title, detail, action, onAction }: { title: string; detail: string; action: string; onAction(): void }) { return <section className="product-card safe-stop-card" aria-live="polite"><div className="safe-stop-symbol"><Icon name="shield" /></div><h2>{title}</h2><p className="card-description">{detail}</p><div className="card-actions"><button className="button bank-primary" type="button" onClick={onAction}>{action}</button></div></section>; }
