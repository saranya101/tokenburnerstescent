import type { PlanPresentation, PlanStep } from "../chat/presentation";
import { PlanRoute, type RouteStepState } from "../plan/plan-route";
import { Icon } from "../ui/icon";

export type TimelineStatus = "complete" | "active" | "waiting" | "paused" | "stopped";
export type TimelineItem = { label: string; detail?: string; status: TimelineStatus };

function routeState(status: TimelineStatus | undefined): RouteStepState {
  if (status === "complete") return "complete";
  if (status === "active") return "active";
  return "pending";
}

export function ExecutionTimeline({ title = "Your approved plan", items, steps = [], scenario }: { title?: string; items: TimelineItem[]; steps?: PlanStep[]; scenario?: PlanPresentation }) {
  const routeScenario: PlanPresentation = scenario ?? { goal: { eyebrow: "", title: "", description: "", details: [], constraints: [], preferences: [] }, planTitle: title, planSummary: "", steps, funding: [], preservedConstraints: [] };
  const routeStates = steps.map((_, index) => routeState(items[index + 2]?.status));
  const complete = items.every((item) => item.status === "complete");
  const terminalStep = steps.at(-1);
  const amount = routeScenario.goal.details.find((item) => item.label === "Amount")?.value;
  const destination = routeScenario.goal.details.find((item) => item.label === "To" || item.label === "Recipient")?.value;
  const result = amount && destination ? `${amount} sent to ${destination}` : `${terminalStep?.title ?? "Transaction"} completed`;
  const checkItems = complete ? items.slice(0, 1) : items.slice(0, 2);
  return <section className="product-card execution-card" aria-live="polite" aria-labelledby="execution-heading">
    <div className="execution-heading"><div><p className="eyebrow">{complete ? "Payment completed" : "Payment in progress"}</p><h2 id="execution-heading">{complete && amount ? amount : title}</h2>{complete && destination && <p className="receipt-recipient">{destination}</p>}</div><span className={`execution-state ${complete ? "is-complete" : ""}`}><Icon name={complete ? "check" : "shield"} />{complete ? "Completed" : "Processing"}</span></div>
    <div className="execution-checks">
      {checkItems.map((item) => <div className={`execution-check is-${item.status}`} key={item.label}><span>{item.status === "complete" ? <Icon name="check" /> : <i />}</span><div><strong>{item.label}</strong><small>{complete ? "Your latest account information was checked before the payment was completed." : item.detail}</small></div></div>)}
    </div>
    {complete && routeScenario.funding.length > 0 && <section className="receipt-funding" aria-label="Funding"><h3>Funding</h3>{routeScenario.funding.map((item) => <div key={`${item.account}:${item.amount}`}><span><strong>{item.account}</strong><small>{item.detail}</small></span><b>{item.amount}</b></div>)}</section>}
    <PlanRoute scenario={routeScenario} states={routeStates} />
    <div className={`bank-confirmation is-${items.at(-1)?.status ?? "waiting"}`}><span>{items.at(-1)?.status === "complete" ? <Icon name="check" /> : <i />}</span><div><strong>{items.at(-1)?.status === "complete" ? `${terminalStep?.kind ?? "Transaction"} confirmed` : items.at(-1)?.label}</strong><small>{items.at(-1)?.detail}</small></div></div>
    {complete && <div className="completion-panel"><span><Icon name="check" /></span><strong>{result}</strong></div>}
  </section>;
}
