"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApprovalOverlay } from "../approval/approval-overlay";
import { ExecutionTimeline, type TimelineItem } from "../execution/execution-timeline";
import { ReapprovalCard } from "../execution/reapproval-card";
import { SafeStopCard } from "../execution/safe-stop-card";
import { ClarificationCard } from "../goal/clarification-card";
import { UnderstoodGoalCard } from "../goal/understood-goal-card";
import { FinancialPlanPreview } from "../plan/financial-plan-preview";
import { Icon } from "../ui/icon";
import { ConversationComposer } from "./conversation-composer";
import { scenarioFor, type DemoScenario } from "./demo-data";

type Phase = "compose" | "goal" | "clarification" | "compiling" | "plan" | "approval" | "executing" | "safe-stop" | "reapproval" | "complete";

function timelineFor(scenario: DemoScenario): TimelineItem[] {
  return [
    { label: "Account checked", detail: "Reviewing balances and availability", status: "active" },
    { label: "Your request can still be completed", detail: "Making sure the approved outcome remains available", status: "waiting" },
    ...scenario.steps.map((step) => ({ label: step.title, detail: step.summary, status: "waiting" as const })),
    { label: "Bank confirmation", detail: "Confirming the completed transaction", status: "waiting" },
  ];
}

export function ChatExperience() {
  const [phase, setPhase] = useState<Phase>("compose");
  const [message, setMessage] = useState("");
  const [scenario, setScenario] = useState<DemoScenario>(() => scenarioFor("NTU"));
  const [timeline, setTimeline] = useState<TimelineItem[]>(() => timelineFor(scenarioFor("NTU")));

  const submit = (nextMessage: string) => {
    const nextScenario = scenarioFor(nextMessage);
    setMessage(nextMessage);
    setScenario(nextScenario);
    setTimeline(timelineFor(nextScenario));
    setPhase(/\bjohn\b/i.test(nextMessage) ? "clarification" : "goal");
  };
  const reset = () => { setPhase("compose"); setMessage(""); setTimeline(timelineFor(scenarioFor("NTU"))); };
  const beginExecution = useCallback(() => setPhase("executing"), []);

  useEffect(() => {
    if (phase !== "compiling") return;
    const timer = window.setTimeout(() => setPhase("plan"), 1400);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "executing") return;
    setTimeline(timelineFor(scenario));
    const stateChecked = window.setTimeout(() => setTimeline((items) => items.map((item, index) => index === 0 ? { ...item, status: "complete" } : index === 1 ? { ...item, status: "active" } : item)), 700);
    const goalChecked = window.setTimeout(() => {
      if (scenario.outcome === "safe-stop") { setPhase("safe-stop"); return; }
      setTimeline((items) => items.map((item, index) => index < 2 ? { ...item, status: "complete" } : index === 2 ? { ...item, status: "active" } : item));
    }, 1450);
    const firstSettled = window.setTimeout(() => {
      if (scenario.outcome !== "success") return;
      setTimeline((items) => items.map((item, index) => index <= 2 ? { ...item, status: "complete" } : index === 3 ? { ...item, status: "active" } : item));
    }, 2250);
    const completed = window.setTimeout(() => {
      if (scenario.outcome !== "success") return;
      setTimeline((items) => items.map((item) => ({ ...item, status: "complete" })));
      setPhase("complete");
    }, 3150);
    return () => { window.clearTimeout(stateChecked); window.clearTimeout(goalChecked); window.clearTimeout(firstSettled); window.clearTimeout(completed); };
  }, [phase, scenario]);

  const completedTimeline = useMemo<TimelineItem[]>(() => timelineFor(scenario).map((item) => ({ ...item, status: "complete" })), [scenario]);
  const isInitial = phase === "compose" && !message;
  const [primaryRequest, ...requestConditions] = message.split(/\s+and\s+/i);

  return <div className={`parlance-workspace ${isInitial ? "is-initial" : "is-active"}`}>
    <header className="workspace-header">
      <div className="workspace-title"><span className="parlance-symbol"><Icon name="spark" /></span><div><p>{isInitial ? "Parlance" : "Active request"}</p><h1>{isInitial ? "Tell us the outcome you want." : "Parlance"}</h1></div></div>
      {isInitial && <span className="workspace-security"><Icon name="shield" />Inside digibank</span>}
    </header>

    <div className="workspace-body">
      {isInitial && <div className="workspace-intro"><h2>What would you like to do?</h2><p>AI helps understand your request. Banking systems decide how it can be completed safely.</p></div>}
      {isInitial && <ConversationComposer onSubmit={submit} />}

      {message && <div className="conversation-stream">
        <div className="request-context"><span className="request-context-icon"><Icon name="spark" /></span><div><small>Your request</small><strong>{primaryRequest}</strong>{requestConditions.length > 0 && <p>{requestConditions.join(" and ")}</p>}</div>{phase !== "compose" && <button type="button" onClick={reset}>Start over <Icon name="arrow" /></button>}</div>
        {phase === "compose" && <ConversationComposer compact initialValue={message} onSubmit={submit} />}
        {phase === "clarification" && <ClarificationCard onCancel={reset} onSelect={(candidate) => {
          setMessage((current) => current.replace(/john/ig, candidate.name));
          setScenario((current) => ({ ...current, goal: { ...current.goal, title: `Send US$5,000 to ${candidate.name}`, description: `A one-time transfer to your confirmed ${candidate.name} beneficiary.`, details: current.goal.details.map((detail) => detail.label === "Recipient" ? { ...detail, value: candidate.name } : detail) } }));
          setPhase("goal");
        }} />}
        {phase === "goal" && <UnderstoodGoalCard goal={scenario.goal} onEdit={() => setPhase("compose")} onConfirm={() => setPhase("compiling")} />}
        {phase === "compiling" && <CompilingState />}
        {phase === "plan" && <FinancialPlanPreview scenario={scenario} onCancel={reset} onApprove={() => setPhase("approval")} />}
        {phase === "approval" && <><FinancialPlanPreview scenario={scenario} onCancel={reset} onApprove={() => undefined} /><ApprovalOverlay scenario={scenario} onCancel={() => setPhase("plan")} onApproved={beginExecution} /></>}
        {phase === "executing" && <ExecutionTimeline items={timeline} steps={scenario.steps} scenario={scenario} />}
        {phase === "complete" && <><ExecutionTimeline title="Your approved plan" items={completedTimeline} steps={scenario.steps} scenario={scenario} /><div className="completion-action"><button type="button" className="button bank-primary" onClick={reset}>Done</button></div></>}
        {phase === "safe-stop" && <SafeStopCard scenario={scenario} onDone={reset} onStartOver={reset} onShowRouteChange={() => setPhase("reapproval")} />}
        {phase === "reapproval" && <ReapprovalCard scenario={scenario} onCancel={reset} onReview={() => setPhase("plan")} />}
      </div>}
    </div>

  </div>;
}

function CompilingState() {
  return <section className="product-card compiling-card" aria-live="polite">
    <div className="compiler-orbit" aria-hidden="true"><span /><i /></div>
    <p className="eyebrow">Goal confirmed</p><h2>Finding a safe route…</h2>
    <p className="card-description">Current bank state is being checked before deterministic banking systems construct a valid route.</p>
    <div className="compile-checks"><span className="done">✓ <strong>Goal locked</strong></span><span className="active"><i /> Checking current bank state</span><span><i /> Constructing a valid route</span></div>
    <p className="trust-note"><Icon name="shield" /> The conversational layer does not create transaction steps.</p>
  </section>;
}
