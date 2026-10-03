import type { OpsRun, OpsStage, OpsStageState } from "../../lib/ops-read-model";
import { redactForDisplay } from "../../lib/ops-read-model";
import { formatMoney } from "../../lib/customer-presentation";
import styles from "./ops.module.css";

const stages = [
  ["request", "Request"],
  ["interpretation", "Interpretation"],
  ["semanticValidation", "Semantic validation"],
  ["confirmedGoal", "Confirmed goal"],
  ["plan", "Plan"],
  ["authorization", "Authorization"],
  ["execution", "Execution"],
  ["bankResult", "Bank result"],
] as const;

export function OpsDashboard({ runs, error }: { runs: OpsRun[]; error?: string }) {
  const completed = runs.filter((run) => run.overallState === "COMPLETED").length;
  const stopped = runs.filter((run) => ["PAUSED", "REAPPROVAL_REQUIRED", "AUTHORIZATION_FAILED", "UNSAT", "POLICY_BLOCKED"].includes(run.overallState)).length;
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div><p className={styles.kicker}>PARLANCE · INTERNAL OBSERVABILITY</p><h1>Execution proof console</h1><p>Read-only evidence from the live request, authorization, execution, and audit records.</p></div>
        <span className={styles.readOnly}><i /> READ ONLY</span>
      </header>

      <section className={styles.boundary} aria-label="Architecture boundary">
        <div className={styles.aiSide}><span>AI / semantic layer</span><strong>AI understands the request.</strong><p>Interpretation and entity grounding stop at a proposed meaning.</p></div>
        <div className={styles.divider}><span>TRUST BOUNDARY</span><i>→</i></div>
        <div className={styles.deterministicSide}><span>Deterministic financial layer</span><strong>Deterministic bank logic decides how money moves.</strong><p>Confirmed goals, compiled steps, passkey evidence, and runtime checks control execution.</p></div>
      </section>

      <section className={styles.summary} aria-label="Run summary">
        <div><span>Recent requests</span><strong>{runs.length}</strong></div>
        <div><span>Completed</span><strong>{completed}</strong></div>
        <div><span>Stopped safely</span><strong>{stopped}</strong></div>
        <div><span>Mode</span><strong>Live DB</strong></div>
      </section>

      <section className={styles.runs}>
        <div className={styles.sectionHeading}><div><p className={styles.kicker}>PIPELINE HISTORY</p><h2>Recent requests</h2></div><span>{runs.length ? "Select a run to inspect its evidence" : "Waiting for a recorded request"}</span></div>
        {error ? <div className={styles.notice}><strong>Unable to load operations data</strong><p>{error}</p></div> : null}
        {!error && runs.length === 0 ? <div className={styles.empty}><span>∅</span><h3>No Parlance runs recorded</h3><p>Real requests will appear here after the API persists an intent candidate. No sample history is generated.</p></div> : null}
        <div className={styles.runList}>
          {runs.map((run, index) => <RunCard run={run} open={index === 0} key={run.id} />)}
        </div>
      </section>
    </main>
  );
}

function RunCard({ run, open }: { run: OpsRun; open: boolean }) {
  return (
    <details className={styles.runCard} open={open}>
      <summary className={styles.runSummary}>
        <span className={`${styles.runState} ${tone(run.overallState)}`}><i />{humanize(run.overallState)}</span>
        <span className={styles.runTitle}><strong>{run.headline}</strong><small>{formatTime(run.occurredAt)} · {run.id}</small></span>
        <span className={styles.chevron}>⌄</span>
      </summary>
      <div className={styles.runBody}>
        <ol className={styles.pipeline} aria-label="Run pipeline">
          {stages.map(([key, label], index) => <PipelineStage label={label} stage={run.stages[key]} boundary={index === 3} key={key} />)}
        </ol>
        <div className={styles.detailGrid}>
          <div className={styles.stageDetails}>
            <div className={styles.columnLabel}>STAGE EVIDENCE</div>
            {stages.map(([key, label]) => <StageDetail label={label} stage={run.stages[key]} key={key} />)}
          </div>
          <aside className={styles.audit}>
            <div className={styles.columnLabel}>AUDIT · CHRONOLOGICAL</div>
            {run.audit.length ? run.audit.map((event) => (
              <details className={styles.auditEvent} key={event.id}>
                <summary><i /><span><strong>{humanize(event.eventType)}</strong><small>{formatTime(event.occurredAt)} · {event.aggregateType}</small></span><b>+</b></summary>
                <div><Meta label="aggregate" value={event.aggregateId} /><Meta label="trace" value={event.traceId} /><DataValue value={event.metadata} /></div>
              </details>
            )) : <div className={styles.noAudit}>No related audit events recorded.</div>}
          </aside>
        </div>
      </div>
    </details>
  );
}

function PipelineStage({ label, stage, boundary }: { label: string; stage: OpsStage; boundary: boolean }) {
  return (
    <li className={`${styles.pipelineStage} ${styles[`stage${stage.state}`]} ${boundary ? styles.pipelineBoundary : ""}`}>
      {boundary ? <span className={styles.boundaryFlag}>DETERMINISTIC</span> : null}
      <i className={styles.stageDot}>{stage.state === "COMPLETE" ? "✓" : stage.state === "FAILED" || stage.state === "STOPPED" ? "!" : ""}</i>
      <span><small>{label}</small><strong>{stateLabel(stage.state)}</strong></span>
    </li>
  );
}

function StageDetail({ label, stage }: { label: string; stage: OpsStage }) {
  return (
    <details className={styles.stagePanel}>
      <summary><span className={`${styles.miniState} ${styles[`stage${stage.state}`]}`}><i /></span><span><strong>{label}</strong><small>{stage.summary}</small></span><b>+</b></summary>
      <div className={styles.stagePanelBody}>{stage.detail ? <DataValue value={redactForDisplay(stage.detail)} /> : <p className={styles.noDetail}>No record exists for this stage.</p>}</div>
    </details>
  );
}

function DataValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span className={styles.scalar}>—</span>;
  if (Array.isArray(value)) return value.length ? <div className={styles.array}>{value.map((item, index) => <div className={styles.arrayItem} key={index}><span className={styles.index}>{String(index + 1).padStart(2, "0")}</span><DataValue value={item} depth={depth + 1} /></div>)}</div> : <span className={styles.scalar}>none</span>;
  if (isMoney(value)) return <span className={styles.money}>{formatMoney(value)} <small>({value.minorUnits} minor units)</small></span>;
  if (typeof value === "object") return <dl className={depth ? styles.nestedData : styles.data}>{Object.entries(value as Record<string, unknown>).map(([key, child]) => <div key={key}><dt>{humanize(key)}</dt><dd><DataValue value={child} depth={depth + 1} /></dd></div>)}</dl>;
  return <span className={typeof value === "boolean" ? (value ? styles.yes : styles.no) : styles.scalar}>{String(value)}</span>;
}

function Meta({ label, value }: { label: string; value: string }) { return <p className={styles.meta}><span>{label}</span>{value}</p>; }
function stateLabel(state: OpsStageState) { return state === "NOT_REACHED" ? "not reached" : state.toLowerCase(); }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/^./, (letter) => letter.toUpperCase()); }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC"; }
function tone(state: string) { if (state === "COMPLETED") return styles.toneComplete; if (state === "FAILED" || state === "AUTHORIZATION_FAILED") return styles.toneFailed; if (["PAUSED", "REAPPROVAL_REQUIRED", "UNSAT", "POLICY_BLOCKED"].includes(state)) return styles.toneStopped; return styles.toneWaiting; }
function isMoney(value: unknown): value is Parameters<typeof formatMoney>[0] { return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).currency === "string" && typeof (value as Record<string, unknown>).minorUnits === "string"; }
