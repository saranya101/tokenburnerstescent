type Detail = {
  state: string; traceId: string;
  goal?: { goal: unknown };
  plan?: { steps: Array<{ id: string; action: string; parameters: unknown }> };
  result: { status: string; steps: Array<{ stepId: string; status: string; bankReference?: string; errorCode?: string }>; goalOutcome: { summary: string } };
};

const apiUrl = process.env.API_URL ?? "http://localhost:4000";

async function loadExecution(id: string): Promise<Detail | null> {
  try { const response = await fetch(`${apiUrl}/v1/executions/${encodeURIComponent(id)}/detail`, { cache: "no-store" }); return response.ok ? response.json() as Promise<Detail> : null; } catch { return null; }
}

export default async function ExecutionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const detail = await loadExecution(id);
  if (!detail) return <section className="card"><h2>Execution {id}</h2><p>Execution details are currently unavailable.</p></section>;
  const requiresApproval = detail.state === "REAPPROVAL_REQUIRED";
  return <div className="grid gap-4">
    <section className="card"><h2>Execution {id}</h2><p>{detail.result.goalOutcome.summary}</p><p><strong>State:</strong> {detail.state}</p><p><strong>Requires approval again:</strong> {requiresApproval ? "Yes" : "No"}</p></section>
    <section className="card"><h3>What you asked for</h3><pre className="overflow-auto text-sm">{JSON.stringify(detail.goal?.goal, null, 2)}</pre></section>
    <section className="card"><h3>Exact approved plan</h3><ol>{detail.plan?.steps.map((step) => <li key={step.id}><strong>{step.action}</strong> — {step.id}<pre className="overflow-auto text-sm">{JSON.stringify(step.parameters, null, 2)}</pre></li>)}</ol></section>
    <section className="card"><h3>Execution progress</h3>{detail.result.steps.length ? <ul>{detail.result.steps.map((step) => <li key={step.stepId}>{step.stepId}: <strong>{step.status}</strong>{step.bankReference ? ` — ${step.bankReference}` : ""}{step.errorCode ? ` — stopped: ${step.errorCode}` : ""}</li>)}</ul> : <p>No financial action has executed.</p>}</section>
    <section className="card"><h3>Safety decision</h3><p>{detail.state === "PAUSED" || requiresApproval ? detail.result.goalOutcome.summary : "Parlance is continuing only while the confirmed goal remains achievable."}</p><p><strong>Trace ID:</strong> {detail.traceId}</p></section>
  </div>;
}
