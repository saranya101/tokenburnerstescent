type OpsExecution = { state: string; result: { executionId: string; status: string; startedStateVersion: number; finalStateVersion?: number; steps: Array<{ stepId: string; status: string; idempotencyKey: string; bankReference?: string }> } };
type Audit = { id?: string; eventType?: string; aggregateId?: string; traceId?: string; occurredAt?: string; payload?: Record<string, unknown> };
const apiUrl = process.env.API_URL ?? "http://localhost:4000";

async function load<T>(path: string): Promise<T[]> { try { const response = await fetch(`${apiUrl}${path}`, { cache: "no-store" }); return response.ok ? response.json() as Promise<T[]> : []; } catch { return []; } }

export default async function OpsPage() {
  const [executions, audit] = await Promise.all([load<OpsExecution>("/v1/ops/executions"), load<Audit>("/v1/ops/audit")]);
  return <div className="grid gap-4">
    <section className="card"><h2>Execution safety</h2><p>Goal → Plan → Approval → State Check → Goal Preservation → Execute/Block → Refresh → Reconcile</p></section>
    <section className="card"><h3>Executions</h3>{executions.length ? executions.map(({ state, result }) => <article key={result.executionId} className="mb-4"><strong>{result.executionId}</strong><p>State: {state} · approved stateVersion: {result.startedStateVersion} · observed stateVersion: {result.finalStateVersion ?? "pending"}</p>{result.steps.map((step) => <p key={step.stepId}>{step.stepId}: {step.status} · idempotency {step.idempotencyKey}{step.bankReference ? ` · bank ${step.bankReference}` : ""}</p>)}</article>) : <p>No executions recorded.</p>}</section>
    <section className="card"><h3>Deterministic trace</h3>{audit.length ? audit.map((event, index) => <article key={event.id ?? `${event.eventType}-${index}`} className="mb-3"><strong>{event.eventType ?? "EVENT"}</strong><p>traceId: {event.traceId ?? "—"} · execution: {event.aggregateId ?? "—"}</p><pre className="overflow-auto text-sm">{JSON.stringify(event.payload ?? {}, null, 2)}</pre></article>) : <p>No audit events recorded.</p>}</section>
  </div>;
}
