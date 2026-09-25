"use client";

import { useEffect, useState } from "react";
import type { DemoScenario } from "../chat/demo-data";
import { Icon } from "../ui/icon";

type ApprovalState = "review" | "checking" | "approved";

export function ApprovalOverlay({ scenario, onCancel, onApproved }: { scenario: DemoScenario; onCancel(): void; onApproved(): void }) {
  const [state, setState] = useState<ApprovalState>("review");

  useEffect(() => {
    if (state !== "checking") return;
    const approved = window.setTimeout(() => setState("approved"), 900);
    return () => window.clearTimeout(approved);
  }, [state]);

  useEffect(() => {
    if (state !== "approved") return;
    const close = window.setTimeout(onApproved, 650);
    return () => window.clearTimeout(close);
  }, [state, onApproved]);

  return <div className="approval-backdrop" role="presentation">
    <section className="approval-overlay" role="dialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-description">
      <header><div className="bank-approval-brand"><span>DBS</span><div><strong id={state === "review" ? "approval-title" : undefined}>Review transaction</strong><small>Bank-secured approval</small></div></div>{state === "review" && <button type="button" className="modal-close" onClick={onCancel} aria-label="Close approval">×</button>}</header>
      {state === "review" ? <>
        <div className="approval-body">
          <p id="approval-description">Confirm the exact financial actions below. This bank-controlled step is separate from the conversation.</p>
          <div className="approval-route">{scenario.steps.map((step, index) => <article key={step.id}><span>{index + 1}</span><div><small>{step.kind}</small><strong>{step.title}</strong><p>{step.summary}</p></div></article>)}</div>
          {scenario.preservedConstraints.length > 0 && <div className="protected-constraint"><span><Icon name="shield" /></span><div><small>Protected condition</small><strong>{scenario.preservedConstraints[0]}</strong></div></div>}
          <div className="approval-security"><Icon name="shield" /><p><strong>You are approving this exact plan.</strong><small>Any meaningful change will require your approval again.</small></p></div>
        </div>
        <footer><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button type="button" className="button bank-primary face-id-button" onClick={() => setState("checking")}><Icon name="shield" />Confirm with Face ID</button><small>Face ID is simulated for this hackathon prototype.</small></footer>
      </> : <div className="approval-status" aria-live="assertive"><div className={`biometric-mark is-${state}`}>{state === "approved" ? <Icon name="check" /> : <span className="face-scan"><i /><i /><i /><i /></span>}</div><h2 id="approval-title">{state === "approved" ? "Identity confirmed" : "Face ID checking…"}</h2><p>{state === "approved" ? "Returning to Parlance to complete your approved plan." : "Simulated biometric check"}</p></div>}
    </section>
  </div>;
}
