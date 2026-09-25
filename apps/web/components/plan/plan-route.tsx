import type { DemoScenario } from "../chat/demo-data";
import { Icon } from "../ui/icon";

export type RouteStepState = "pending" | "active" | "complete" | "unavailable" | "not-executed";

export function PlanRoute({ scenario, states, compact = false }: { scenario: DemoScenario; states?: RouteStepState[]; compact?: boolean }) {
  return <div className={`premium-route ${compact ? "is-compact" : ""}`} aria-label="Transaction plan">
    {scenario.steps.map((step, index) => {
      const state = states?.[index] ?? "pending";
      return <article className={`premium-route-step is-${state}`} key={step.id}>
        <div className="route-marker"><span>{state === "complete" ? <Icon name="check" /> : state === "unavailable" ? <Icon name="warning" /> : index + 1}</span>{index < scenario.steps.length - 1 && <i />}</div>
        <div className="route-step-icon"><Icon name={step.kind.toLowerCase().includes("convert") ? "fx" : step.kind.toLowerCase().includes("buy") ? "asset" : "transfer"} /></div>
        <div className="route-step-copy"><small>{step.kind}</small><h3>{step.title}</h3><p>{step.summary}</p>{!compact && <dl>{step.meta.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}</div>
        {states && <span className="route-step-status">{state === "complete" ? "Completed" : state === "active" ? "In progress" : state === "unavailable" ? "No longer available" : state === "not-executed" ? "Not executed" : "Pending"}</span>}
      </article>;
    })}
  </div>;
}
