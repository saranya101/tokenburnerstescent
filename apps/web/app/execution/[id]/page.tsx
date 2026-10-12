import { apiBaseUrl, customerApiHeaders } from "../../../lib/server-api-auth";

type Detail = { state: string; result: { status: string; steps: Array<{ stepId: string; status: string }>; goalOutcome: { summary: string } } };

async function loadExecution(id: string): Promise<Detail | null> {
  const authorization = customerApiHeaders();
  if (!authorization) return null;
  try { const response = await fetch(`${apiBaseUrl()}/v1/executions/${encodeURIComponent(id)}/detail`, { cache: "no-store", headers: authorization }); return response.ok ? response.json() as Promise<Detail> : null; } catch { return null; }
}

export default async function ExecutionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const detail = await loadExecution(id);
  if (!detail) return <section className="card"><h2>Execution {id}</h2><p>Execution details are currently unavailable.</p></section>;
  const requiresApproval = detail.state === "REAPPROVAL_REQUIRED";
  return <div className="grid gap-4">
    <section className="card"><h2>Transaction status</h2><p>{detail.result.goalOutcome.summary}</p><p><strong>Status:</strong> {detail.state}</p><p><strong>Requires approval again:</strong> {requiresApproval ? "Yes" : "No"}</p></section>
    <section className="card"><h3>Progress</h3>{detail.result.steps.length ? <ul>{detail.result.steps.map((step, index) => <li key={step.stepId}>Action {index + 1}: <strong>{step.status}</strong></li>)}</ul> : <p>No financial action has executed.</p>}</section>
  </div>;
}
