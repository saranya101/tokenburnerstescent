"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon, type IconName } from "../../components/ui/icon";
import { formatMoney } from "../../lib/customer-presentation";
import type { OpsRun, OpsStageState } from "../../lib/ops-read-model";
import { redactForDisplay } from "../../lib/ops-read-model";
import styles from "./ops.module.css";

type View = "overview" | "executions" | "plans" | "approvals" | "audit";
type StageKey = keyof OpsRun["stages"];
type AccessState = "authenticated" | "required" | "unconfigured";

const nav: Array<{ id: View; label: string; icon: IconName }> = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "executions", label: "Executions", icon: "transfer" },
  { id: "plans", label: "Plan traces", icon: "asset" },
  { id: "approvals", label: "Approvals", icon: "shield" },
  { id: "audit", label: "Audit trail", icon: "accounts" },
];

const stageDefinitions: Array<{ key: StageKey; label: string; timelineLabel: string }> = [
  { key: "interpretation", label: "Intent", timelineLabel: "Request interpreted" },
  { key: "interpretation", label: "Entity bindings", timelineLabel: "Entities grounded" },
  { key: "confirmedGoal", label: "Confirmed goal", timelineLabel: "Goal confirmed" },
  { key: "plan", label: "Financial plan", timelineLabel: "Financial plan compiled" },
  { key: "authorization", label: "Authorization", timelineLabel: "Plan authorized" },
  { key: "authorization", label: "Passkey evidence", timelineLabel: "Passkey verified" },
  { key: "execution", label: "Execution", timelineLabel: "Bank operations executed" },
  { key: "bankResult", label: "Reconciliation", timelineLabel: "State revalidated / reconciled" },
  { key: "bankResult", label: "Final outcome", timelineLabel: "Final outcome" },
];

const stoppedStates = new Set(["PAUSED", "REAPPROVAL_REQUIRED", "AUTHORIZATION_FAILED", "UNSAT", "POLICY_BLOCKED", "RISK_REVIEW", "RISK_BLOCK", "SEMANTIC_VALIDATION_FAILED"]);

export function OpsDashboard({ runs, error, accessState = "authenticated", environment = "ENVIRONMENT UNVERIFIED", initialView = "overview", initialStage = "request" }: { runs: OpsRun[]; error?: string; accessState?: AccessState; environment?: string; initialView?: View; initialStage?: StageKey }) {
  const [view, setView] = useState<View>(initialView);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [selectedId, setSelectedId] = useState(runs[0]?.id ?? "");
  const [selectedStage, setSelectedStage] = useState<StageKey>(initialStage);
  const [busy, setBusy] = useState(false);

  const statuses = useMemo(() => [...new Set(runs.map((run) => run.overallState))].sort(), [runs]);
  const filteredRuns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return runs.filter((run) => (status === "ALL" || run.overallState === status) && (!needle || `${run.headline} ${run.id} ${goalType(run)}`.toLowerCase().includes(needle)));
  }, [query, runs, status]);
  const selected = runs.find((run) => run.id === selectedId) ?? filteredRuns[0] ?? runs[0];
  const completed = runs.filter((run) => run.overallState === "COMPLETED").length;
  const stopped = runs.filter((run) => stoppedStates.has(run.overallState)).length;
  const reapproval = runs.filter((run) => run.overallState === "REAPPROVAL_REQUIRED").length;

  function inspect(run: OpsRun, nextView: View = "executions") {
    setSelectedId(run.id);
    setSelectedStage(nextView === "plans" ? "plan" : nextView === "approvals" ? "authorization" : "request");
    setView(nextView);
  }

  async function logout() {
    setBusy(true);
    try { await fetch("/api/operator/session", { method: "DELETE" }); window.location.assign("/operator/login"); }
    finally { setBusy(false); }
  }

  return <div className={styles.appShell}>
    <header className={styles.topbar}>
      <div className={styles.brand}><span className={styles.dbs}>DBS</span><span className={styles.brandDivider} /><span><strong>Parlance</strong><small>Operations Portal</small></span></div>
      <div className={styles.headerStatus}>
        <span className={styles.environment}><i />{environment}</span>
        <span className={styles.readOnly}><Icon name="eye" />Read only</span>
        <span className={styles.authStatus}><i className={accessState === "authenticated" ? styles.online : styles.offline} />{accessState === "authenticated" ? "Operator authenticated" : "Authentication required"}</span>
        {accessState === "authenticated" ? <button className={styles.operatorMenu} type="button" onClick={logout} disabled={busy} aria-label="Sign out operator session"><Icon name="recipient" /><span>Operator session<small>{busy ? "Signing out…" : "Sign out"}</small></span></button> : null}
      </div>
    </header>

    <aside className={styles.sidebar} aria-label="Operations navigation">
      <nav>{nav.map((item) => <button type="button" key={item.id} className={view === item.id ? styles.activeNav : ""} onClick={() => setView(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav>
      <div className={styles.sidebarFooter}><Icon name="shield" /><span><strong>Protected workspace</strong><small>Server-authorized access</small></span></div>
    </aside>

    <main className={styles.main}>
      {accessState !== "authenticated" ? <AccessRequired state={accessState} /> : error ? <ErrorState error={error} refresh={() => window.location.reload()} /> : runs.length === 0 ? <EmptyState /> : <>
        <section className={styles.pageHeader}>
          <div><p className={styles.eyebrow}>OPERATIONS / {nav.find((item) => item.id === view)?.label.toUpperCase()}</p><h1>{viewTitle(view)}</h1><p>{viewSubtitle(view)}</p></div>
          <button className={styles.refresh} type="button" onClick={() => window.location.reload()}><Icon name="arrow" />Refresh data</button>
        </section>

        {view === "overview" ? <>
          <section className={styles.metrics} aria-label="Operational metrics"><Metric label="Total requests" value={runs.length} tone="neutral" /><Metric label="Completed executions" value={completed} tone="success" /><Metric label="Stopped safely" value={stopped} tone="warning" /><Metric label="Reapproval required" value={reapproval} tone="danger" /></section>
          <section className={styles.architecture} aria-label="Decision boundary"><div><span className={styles.aiMark}>AI</span><p><strong>Language interpretation</strong><small>AI understands the request.</small></p></div><span className={styles.trustBoundary}>CONFIRMED MEANING <i>→</i></span><div><span className={styles.bankMark}><Icon name="shield" /></span><p><strong>Deterministic financial control</strong><small>Deterministic bank logic decides how money moves.</small></p></div></section>
        </> : null}

        {view === "audit" ? <AuditTrail runs={runs} /> : view === "plans" ? <FocusedRuns title="Financial plan traces" empty="No compiled plan evidence is available." runs={filteredRuns.filter((run) => run.stages.plan.state !== "NOT_REACHED")} selected={selected} onInspect={(run) => inspect(run, "plans")} stage="plan" /> : view === "approvals" ? <FocusedRuns title="Approval evidence" empty="No authorization evidence is available." runs={filteredRuns.filter((run) => run.stages.authorization.state !== "NOT_REACHED")} selected={selected} onInspect={(run) => inspect(run, "approvals")} stage="authorization" /> : <>
          <ExecutionHistory runs={filteredRuns} statuses={statuses} query={query} status={status} selectedId={selected?.id} onQuery={setQuery} onStatus={setStatus} onInspect={inspect} />
          {view === "executions" && selected ? <ExecutionDetail run={selected} selectedStage={selectedStage} onStage={setSelectedStage} onBack={() => setView("overview")} /> : null}
        </>}
      </>}
    </main>
  </div>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) { return <article className={styles.metric}><span className={`${styles.metricIcon} ${styles[tone]}`}><i /></span><p>{label}<strong>{value}</strong></p></article>; }

function ExecutionHistory({ runs, statuses, query, status, selectedId, onQuery, onStatus, onInspect }: { runs: OpsRun[]; statuses: string[]; query: string; status: string; selectedId?: string | undefined; onQuery(value: string): void; onStatus(value: string): void; onInspect(run: OpsRun): void }) {
  return <section className={styles.card} aria-labelledby="execution-history-heading"><div className={styles.cardHeader}><div><h2 id="execution-history-heading">Execution history</h2><p>Customer requests and their latest recorded financial state.</p></div><div className={styles.tableTools}><label><span className={styles.srOnly}>Search executions</span><Icon name="search" /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search requests or references" /></label><select value={status} onChange={(event) => onStatus(event.target.value)} aria-label="Filter by status"><option value="ALL">All statuses</option>{statuses.map((value) => <option value={value} key={value}>{humanize(value)}</option>)}</select></div></div><div className={styles.tableWrap}><table className={styles.executionTable}><thead><tr><th>Request / goal</th><th>Goal type</th><th>Created at</th><th>Status</th><th>Steps</th><th>Execution reference</th><th><span className={styles.srOnly}>Action</span></th></tr></thead><tbody>{runs.map((run) => <tr key={run.id} className={selectedId === run.id ? styles.selectedRow : ""}><td><strong>{run.headline}</strong><small>{moneySummary(run)}</small></td><td>{goalTypeDisplay(run)}</td><td>{formatTime(run.occurredAt)}</td><td><Status state={run.overallState} /></td><td>{stepCount(run)}</td><td><Reference value={executionReference(run)} /></td><td><button className={styles.inspect} type="button" onClick={() => onInspect(run)}>Inspect <span>→</span></button></td></tr>)}</tbody></table></div>{runs.length === 0 ? <div className={styles.filteredEmpty}><Icon name="search" /><strong>No matching executions</strong><p>Adjust the search or status filter to see available records.</p></div> : null}</section>;
}

function ExecutionDetail({ run, selectedStage, onStage, onBack }: { run: OpsRun; selectedStage: StageKey; onStage(key: StageKey): void; onBack(): void }) {
  const evidence = run.stages[selectedStage];
  return <section className={styles.detail} aria-labelledby="execution-detail-heading"><div className={styles.detailHeader}><button type="button" onClick={onBack} className={styles.back}>← Back to overview</button><div><p className={styles.eyebrow}>EXECUTION INSPECTION</p><h2 id="execution-detail-heading">{run.headline}</h2><span><Status state={run.overallState} /> <Reference value={executionReference(run)} /></span></div></div><dl className={styles.summaryGrid}>{summaryFields(run).map((field) => <Summary key={field.label} label={field.label} value={field.value} />)}</dl><div className={styles.inspectionGrid}>
    <section className={styles.timelinePanel}><div className={styles.panelHeading}><span>Lifecycle evidence</span><small>Select a stage to inspect its record</small></div><ol className={styles.timeline}>{stageDefinitions.map((definition, index) => { const derived = timelineState(run, index); return <li key={`${definition.key}-${index}`}><button type="button" className={selectedStage === definition.key ? styles.activeStage : ""} onClick={() => onStage(definition.key)}><span className={`${styles.timelineDot} ${styles[`stage${derived}`]}`}>{derived === "COMPLETE" ? "✓" : derived === "FAILED" || derived === "STOPPED" ? "!" : ""}</span><span><strong>{definition.timelineLabel}</strong><small>{timelineStatusLabel(derived)}</small></span></button>{index === 1 ? <span className={styles.boundaryLabel}>DETERMINISTIC CONTROL BEGINS</span> : null}</li>; })}</ol></section>
    <section className={styles.evidencePanel}><div className={styles.panelHeading}><span>{stageDefinitions.find((item) => item.key === selectedStage)?.label ?? humanize(selectedStage)} evidence</span><Status state={evidence.state} compact /></div><div className={styles.evidenceIntro}><strong>{evidence.summary}</strong><small>Recorded evidence is shown below. Missing fields are not inferred.</small></div>{evidence.detail ? <DataValue value={redactForDisplay(evidence.detail)} /> : <MissingEvidence />}</section>
    <aside className={styles.auditPanel}><div className={styles.panelHeading}><span>Related audit</span><small>{run.audit.length} events</small></div><div className={styles.auditList}>{run.audit.length ? run.audit.map((event) => <details key={event.id}><summary><i /><span><strong>{humanize(event.eventType)}</strong><small>{formatTime(event.occurredAt)}</small></span><b>+</b></summary><div><Reference value={event.id} label="Event" /><Meta label="Aggregate" value={`${event.aggregateType} · ${event.aggregateId}`} /><Meta label="Trace" value={event.traceId} /><DataValue value={redactForDisplay(event.metadata)} /></div></details>) : <MissingEvidence />}</div></aside>
  </div></section>;
}

function FocusedRuns({ title, empty, runs, selected, onInspect, stage }: { title: string; empty: string; runs: OpsRun[]; selected?: OpsRun | undefined; onInspect(run: OpsRun): void; stage: StageKey }) {
  const active = selected && runs.some((run) => run.id === selected.id) ? selected : runs[0];
  return <section className={styles.focusedGrid}><div className={styles.card}><div className={styles.cardHeader}><div><h2>{title}</h2><p>Read-only records from the operator evidence model.</p></div></div>{runs.length ? <div className={styles.focusedList}>{runs.map((run) => <button type="button" onClick={() => onInspect(run)} className={active?.id === run.id ? styles.focusedActive : ""} key={run.id}><span><strong>{run.headline}</strong><small>{formatTime(run.occurredAt)} · {run.id}</small></span><Status state={run.stages[stage].state} compact /></button>)}</div> : <div className={styles.filteredEmpty}><Icon name="shield" /><strong>Evidence unavailable</strong><p>{empty}</p></div>}</div>{active ? <div className={styles.focusedEvidence}><div className={styles.panelHeading}><span>{humanize(stage)} evidence</span><Status state={active.stages[stage].state} compact /></div><p className={styles.focusedSummary}>{active.stages[stage].summary}</p>{active.stages[stage].detail ? <DataValue value={redactForDisplay(active.stages[stage].detail)} /> : <MissingEvidence />}</div> : null}</section>;
}

function AuditTrail({ runs }: { runs: OpsRun[] }) {
  const events = runs.flatMap((run) => run.audit.map((event) => ({ ...event, runHeadline: run.headline }))).sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
  return <section className={styles.card}><div className={styles.cardHeader}><div><h2>Audit trail</h2><p>Chronological events related to the retrieved customer requests.</p></div><span className={styles.recordCount}>{events.length} records</span></div>{events.length ? <div className={styles.auditTableWrap}><table className={styles.executionTable}><thead><tr><th>Event</th><th>Related request</th><th>Timestamp</th><th>Aggregate</th><th>Trace reference</th></tr></thead><tbody>{events.map((event) => <tr key={`${event.id}-${event.occurredAt}`}><td><strong>{humanize(event.eventType)}</strong><small>{event.id}</small></td><td>{event.runHeadline}</td><td>{formatTime(event.occurredAt)}</td><td>{event.aggregateType}<small>{event.aggregateId}</small></td><td><Reference value={event.traceId} /></td></tr>)}</tbody></table></div> : <div className={styles.filteredEmpty}><Icon name="accounts" /><strong>No related audit events</strong><p>The retrieved requests do not have audit evidence in the current read model.</p></div>}</section>;
}

function AccessRequired({ state }: { state: Exclude<AccessState, "authenticated"> }) { return <section className={styles.statePage}><span className={styles.stateIcon}><Icon name="shield" /></span><p className={styles.eyebrow}>PROTECTED OPERATIONS WORKSPACE</p><h1>{state === "unconfigured" ? "Operator access is not configured" : "Operator sign-in required"}</h1><p>{state === "unconfigured" ? "This environment does not have the complete server-side operator session configuration. No operations data was requested." : "Sign in with an authorized operator credential to inspect read-only execution evidence."}</p>{state === "required" ? <Link href="/operator/login" className={styles.primaryAction}>Continue to operator sign-in <span>→</span></Link> : <span className={styles.configurationNote}>Ask the local environment owner to configure operator access.</span>}<small>Customer sessions never inherit operator permissions.</small></section>; }
function ErrorState({ error, refresh }: { error: string; refresh(): void }) { return <section className={styles.statePage}><span className={`${styles.stateIcon} ${styles.errorIcon}`}><Icon name="warning" /></span><p className={styles.eyebrow}>DATA UNAVAILABLE</p><h1>Operations data could not be loaded</h1><p>{error}</p><button type="button" className={styles.primaryAction} onClick={refresh}>Try again</button><small>No fallback records are displayed.</small></section>; }
function EmptyState() { return <section className={styles.statePage}><span className={styles.stateIcon}><Icon name="accounts" /></span><p className={styles.eyebrow}>EXECUTION HISTORY</p><h1>No Parlance requests recorded</h1><p>Real requests will appear after the API persists an intent candidate. The portal does not generate sample history.</p></section>; }
function MissingEvidence() { return <div className={styles.missing}><Icon name="warning" /><span><strong>Evidence unavailable</strong><small>No recorded detail exists for this stage.</small></span></div>; }
function Summary({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function Status({ state, compact = false }: { state: string; compact?: boolean }) { return <span className={`${styles.status} ${styles[`tone${toneName(state)}`]} ${compact ? styles.compactStatus : ""}`}><i />{humanize(state)}</span>; }
function Reference({ value, label }: { value: string; label?: string }) { const [copied, setCopied] = useState(false); return <span className={styles.reference}>{label ? <small>{label}</small> : null}<code title={value}>{value}</code><button type="button" aria-label={`Copy ${label?.toLowerCase() ?? "reference"}`} onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : "Copy"}</button></span>; }
function Meta({ label, value }: { label: string; value: string }) { return <p className={styles.meta}><span>{label}</span>{value}</p>; }

function DataValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span className={styles.scalar}>—</span>;
  if (Array.isArray(value)) return value.length ? <div className={styles.array}>{value.map((item, index) => <div className={styles.arrayItem} key={index}><span className={styles.index}>{index + 1}</span><DataValue value={item} depth={depth + 1} /></div>)}</div> : <span className={styles.scalar}>None recorded</span>;
  if (isMoney(value)) return <span className={styles.money}>{formatMoney(value)} <small>{value.minorUnits} minor units</small></span>;
  if (typeof value === "object") return <dl className={depth ? styles.nestedData : styles.data}>{Object.entries(value as Record<string, unknown>).map(([key, child]) => <div key={key}><dt>{humanize(key)}</dt><dd><DataValue value={child} depth={depth + 1} /></dd></div>)}</dl>;
  return <span className={typeof value === "boolean" ? (value ? styles.yes : styles.no) : styles.scalar}>{String(value)}</span>;
}

function timelineState(run: OpsRun, index: number): OpsStageState { if (index === 1) return groundedEntities(run).length > 0 ? "COMPLETE" : "NOT_REACHED"; if (index === 5) return run.stages.authorization.detail?.userVerified === true ? "COMPLETE" : run.stages.authorization.state === "FAILED" || run.stages.authorization.state === "STOPPED" ? run.stages.authorization.state : "NOT_REACHED"; return run.stages[stageDefinitions[index]!.key].state; }
function goalType(run: OpsRun): string {
  const types = bundleItems(run).map((item) => stringValue(item.goalType) ?? stringValue(record(item.goal).type)).filter((value): value is string => Boolean(value));
  if (types.length > 0) return types.map(goalTypeLabel).join(" + ");
  return stringValue(run.stages.confirmedGoal.detail?.goalType) ?? stringValue(run.stages.interpretation.detail?.goalType) ?? "Not recorded";
}
function stepCount(run: OpsRun): number { const plan = run.stages.plan.detail?.actions; const execution = run.stages.execution.detail?.steps; return Array.isArray(execution) ? execution.length : Array.isArray(plan) ? plan.length : 0; }
function executionReference(run: OpsRun): string { return stringValue(run.stages.execution.detail?.executionId) ?? run.id; }
function bankState(run: OpsRun): string { const final = run.stages.execution.detail?.finalStateVersion; const planned = run.stages.plan.detail?.bankStateVersion; return String(final && final !== "pending" ? final : planned ?? "Not recorded"); }
function moneySummary(run: OpsRun): string {
  const itemSummaries = bundleItems(run).map(transactionSummary).filter((value): value is string => Boolean(value));
  if (itemSummaries.length > 0) return itemSummaries.join(" · ");
  const detail = run.stages.confirmedGoal.detail;
  const goal = record(detail?.goal);
  const directMoney = money(goal.amount) ?? money(goal.budget) ?? money(detail?.amount);
  if (directMoney) return formatMoney(directMoney);
  if (stringValue(goal.type) === "ACQUIRE_ASSET" && stringValue(goal.quantity)) return `${stringValue(goal.quantity)} share${stringValue(goal.quantity) === "1" ? "" : "s"}`;
  return "Amount not recorded";
}
function destination(run: OpsRun): string {
  const detail = run.stages.confirmedGoal.detail;
  const goal = record(detail?.goal);
  const recipientId = stringValue(goal.recipientId);
  const beneficiary = groundedEntities(run).find((binding) => binding.entityType === "BENEFICIARY" && (!recipientId || binding.canonicalId === recipientId));
  return beneficiary?.reference ?? recipientId ?? "Not recorded";
}

function summaryFields(run: OpsRun): Array<{ label: string; value: string }> {
  const items = bundleItems(run);
  if (items.length === 0) return [
    { label: "Goal type", value: goalTypeDisplay(run) },
    { label: "Goal confirmation", value: stateLabel(run.stages.confirmedGoal.state) },
    { label: "Amount", value: moneySummary(run) },
    { label: "Destination", value: destination(run) },
    { label: "Execution steps", value: String(stepCount(run)) },
    { label: "Recorded at", value: formatTime(run.occurredAt) },
    { label: "Bank-state reference", value: bankState(run) },
    { label: "Outcome", value: run.stages.bankResult.summary },
  ];
  const investment = items.find((item) => stringValue(item.goalType) === "ACQUIRE_ASSET");
  const goalFields = items.map((item) => {
    const type = stringValue(item.goalType) ?? stringValue(record(item.goal).type) ?? "GOAL";
    if (type === "DELIVER_MONEY") return { label: "Transfer", value: transferSummary(item) };
    if (type === "ACQUIRE_ASSET") return { label: "Investment", value: investmentSummary(item) };
    return { label: goalTypeLabel(type), value: stringValue(item.summary) ?? "Confirmed goal recorded" };
  });
  const funding = fundingSummary(run, investment);
  const minimum = protectedBalance(run);
  return [
    { label: "Goals", value: goalType(run) },
    { label: "Meaning", value: stateLabel(run.stages.confirmedGoal.state) },
    ...goalFields,
    ...(funding ? [{ label: "Funding", value: funding }] : []),
    ...(minimum ? [{ label: "Minimum protected balance", value: minimum }] : []),
    { label: "Execution steps", value: String(stepCount(run)) },
    { label: "Bank-state reference", value: bankState(run) },
    { label: "Authorization", value: run.stages.authorization.summary },
    { label: "Outcome", value: run.stages.bankResult.summary },
  ];
}
function goalTypeDisplay(run: OpsRun): string { return bundleItems(run).length > 0 ? goalType(run) : humanize(goalType(run)); }
function bundleItems(run: OpsRun): Record<string, unknown>[] {
  return Array.isArray(run.stages.confirmedGoal.detail?.items) ? run.stages.confirmedGoal.detail.items.map(record) : [];
}
function groundedEntities(run: OpsRun): Array<{ reference: string; entityType: string; canonicalId?: string; confirmed: boolean }> {
  const confirmed = Array.isArray(run.stages.confirmedGoal.detail?.confirmedBindings) ? run.stages.confirmedGoal.detail.confirmedBindings.map(record) : [];
  const source = confirmed.length > 0 ? confirmed.filter((binding) => binding.confirmed === true) : Array.isArray(run.stages.interpretation.detail?.groundedEntities) ? run.stages.interpretation.detail.groundedEntities.map(record) : [];
  return source.flatMap((binding) => {
    const reference = stringValue(binding.reference); const entityType = stringValue(binding.entityType); const canonicalId = stringValue(binding.canonicalId);
    return reference && entityType ? [{ reference, entityType, ...(canonicalId ? { canonicalId } : {}), confirmed: binding.confirmed === true || confirmed.length === 0 }] : [];
  });
}
function itemBinding(item: Record<string, unknown> | undefined, entityType: string, canonicalId?: string): { reference: string } | undefined {
  if (!item || !Array.isArray(item.confirmedBindings)) return undefined;
  const binding = item.confirmedBindings.map(record).find((candidate) => candidate.confirmed === true && candidate.entityType === entityType && (!canonicalId || candidate.canonicalId === canonicalId));
  const reference = stringValue(binding?.reference);
  return reference ? { reference } : undefined;
}
function goalTypeLabel(type: string): string {
  return ({ DELIVER_MONEY: "Transfer", ACQUIRE_ASSET: "Buy Asset", MOVE_FUNDS: "Move Funds", PAY_BILL: "Pay Bill" } as Record<string, string>)[type] ?? humanize(type);
}
function transactionSummary(item: Record<string, unknown>): string | undefined {
  const goal = record(item.goal); const type = stringValue(item.goalType) ?? stringValue(goal.type);
  if (type === "DELIVER_MONEY") {
    const amount = money(goal.amount); const recipientId = stringValue(goal.recipientId); const recipient = itemBinding(item, "BENEFICIARY", recipientId)?.reference;
    return amount ? `${formatMoney(amount)}${recipient ? ` to ${recipient}` : " transfer"}` : undefined;
  }
  if (type === "ACQUIRE_ASSET") return investmentSummary(item).replace(/^Buy /u, "");
  return undefined;
}
function transferSummary(item: Record<string, unknown> | undefined): string {
  if (!item) return "Not recorded";
  return transactionSummary(item) ?? "Not recorded";
}
function investmentSummary(item: Record<string, unknown> | undefined): string {
  if (!item) return "Not recorded";
  const goal = record(item.goal); const quantity = stringValue(goal.quantity); const assetId = stringValue(goal.assetId); const reference = itemBinding(item, "ASSET", assetId)?.reference;
  const ticker = reference?.match(/\(([A-Z][A-Z0-9.]{0,9})\)/u)?.[1];
  if (!quantity) return "Not recorded";
  const asset = ticker ?? reference ?? assetId ?? "asset";
  return `Buy ${quantity} ${asset} share${quantity === "1" ? "" : "s"}`;
}
function fundingSummary(run: OpsRun, investment: Record<string, unknown> | undefined): string | undefined {
  const actions = Array.isArray(run.stages.plan.detail?.actions) ? run.stages.plan.detail.actions.map(record) : [];
  const fx = actions.find((action) => action.action === "FX_CONVERT");
  if (!fx) return undefined;
  const parameters = record(fx.parameters); const source = money(parameters.sourceMoney); const target = stringValue(parameters.targetCurrency) ?? "target currency";
  const conditional = Boolean(investment && Array.isArray(investment.preferences) && investment.preferences.map(record).some((preference) => preference.type === "PREFER_ACCOUNT"));
  return `${conditional ? "Conditional funding" : "Planned conversion"}: ${source ? formatMoney(source) : "source amount not recorded"} → ${target}`;
}
function protectedBalance(run: OpsRun): string | undefined {
  const constraints = Array.isArray(run.stages.confirmedGoal.detail?.globalConstraints) ? run.stages.confirmedGoal.detail.globalConstraints.map(record) : [];
  const protectedMinimum = constraints.find((constraint) => constraint.type === "MIN_AVAILABLE_BALANCE");
  const value = money(protectedMinimum?.money);
  return value ? formatMoney(value) : undefined;
}
function money(value: unknown): Parameters<typeof formatMoney>[0] | undefined { return isMoney(value) ? value : undefined; }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function viewTitle(view: View) { return view === "overview" ? "Transaction monitoring" : view === "executions" ? "Execution inspection" : view === "plans" ? "Plan traces" : view === "approvals" ? "Approval evidence" : "Audit trail"; }
function viewSubtitle(view: View) { return view === "overview" ? "Inspect customer requests, financial decisions and execution evidence." : view === "executions" ? "Review the recorded lifecycle and evidence for a selected transaction." : view === "plans" ? "Inspect deterministic compiler outcomes, dependencies and bank-state bindings." : view === "approvals" ? "Review recorded authorization state and passkey verification evidence." : "Trace recorded events across customer requests and financial execution."; }
function timelineStatusLabel(state: OpsStageState) { return state === "COMPLETE" ? "Verified" : state === "NOT_REACHED" ? "Evidence unavailable" : humanize(state); }
function stateLabel(state: OpsStageState) { return state === "COMPLETE" ? "Confirmed" : state === "NOT_REACHED" ? "Evidence unavailable" : humanize(state); }
function toneName(state: string) { if (["COMPLETE", "COMPLETED"].includes(state)) return "Success"; if (["FAILED", "AUTHORIZATION_FAILED", "RISK_BLOCK", "POLICY_BLOCKED"].includes(state)) return "Danger"; if (stoppedStates.has(state) || state === "STOPPED") return "Warning"; return "Neutral"; }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/^./, (letter) => letter.toUpperCase()); }
function formatTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value;

  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];

  const month = months[Number(get("month")) - 1];
  const day = get("day");
  const year = get("year");
  const hour = get("hour");
  const minute = get("minute");

  if (!month || !day || !year || !hour || !minute) {
    return value;
  }

  return `${day} ${month} ${year}, ${hour}:${minute} SGT`;
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMoney(value: unknown): value is Parameters<typeof formatMoney>[0] { return isRecord(value) && typeof value.currency === "string" && typeof value.minorUnits === "string"; }
