import type { DemoScenario } from "../chat/demo-data";
import { PlanRoute } from "../plan/plan-route";
import { Icon } from "../ui/icon";

export function SafeStopCard({ scenario, onDone, onStartOver, onShowRouteChange }: { scenario: DemoScenario; onDone(): void; onStartOver(): void; onShowRouteChange(): void }) {
  return <div className="safe-stop-layout">
    <section className="product-card stopped-plan-card" aria-labelledby="safe-stop-plan-heading"><div className="card-heading-row"><div><p className="eyebrow">Your approved plan</p><h2 id="safe-stop-plan-heading">{scenario.planTitle}</h2></div><span className="stopped-status"><Icon name="shield" />Stopped safely</span></div><PlanRoute scenario={scenario} states={scenario.steps.map((_, index) => index === scenario.steps.length - 1 ? "unavailable" : "not-executed")} /></section>
    <section className="product-card safe-stop-card" aria-labelledby="safe-stop-heading">
      <div className="safe-stop-symbol"><Icon name="shield" /></div><p className="eyebrow">Protected by Parlance</p><h2 id="safe-stop-heading">Execution stopped safely</h2>
      <p className="safe-stop-lead"><strong>Apple can no longer be purchased.</strong><br />Converting your SGD would no longer achieve the goal you approved, so Parlance stopped before moving any money.</p>
      <div className="money-moved"><strong>S$0</strong><span>moved</span></div>
      <div className="safe-stop-detail"><p><Icon name="check" />No partial transaction occurred</p><p><Icon name="check" />Your balances are unchanged</p></div>
      <div className="safe-stop-actions"><button className="button bank-primary" type="button" onClick={onDone}>Done</button><button className="button secondary" type="button" onClick={onStartOver}>Start another request</button><button className="text-button" type="button" onClick={onShowRouteChange}>See route-change protection</button></div>
    </section>
  </div>;
}
