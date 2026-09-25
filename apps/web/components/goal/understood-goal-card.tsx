import type { GoalSummary } from "../chat/demo-data";
import { Icon } from "../ui/icon";

export function UnderstoodGoalCard({ goal, onEdit, onConfirm }: { goal: GoalSummary; onEdit(): void; onConfirm(): void }) {
  return <section className="product-card goal-card" aria-labelledby="understood-heading">
    <div className="card-heading-row">
      <div><p className="eyebrow">Your confirmed goal</p><h2 id="understood-heading">{goal.title}</h2></div>
      <span className="status-badge"><Icon name="check" />Ready to confirm</span>
    </div>
    <p className="card-description">{goal.description}</p>
    <dl className="detail-grid">{goal.details.map((detail, index) => <div key={detail.label}><span className="detail-icon"><Icon name={index === 0 ? "recipient" : "wallet"} /></span><div><dt>{detail.label}</dt><dd>{detail.value}</dd></div></div>)}</dl>
    {(goal.constraints.length > 0 || goal.preferences.length > 0) && <div className="goal-rules">
      {goal.constraints.map((constraint) => <div className="rule-row" key={constraint}><span className="rule-icon"><Icon name="shield" /></span><div><span>Protected condition</span><strong>{constraint}</strong></div></div>)}
      {goal.preferences.map((preference) => <div className="rule-row preference" key={preference}><span className="rule-icon"><Icon name="spark" /></span><div><span>Preference</span><strong>{preference}</strong></div></div>)}
    </div>}
    <div className="card-actions"><button className="button secondary" type="button" onClick={onEdit}>Edit</button><button className="button primary" type="button" onClick={onConfirm}>Confirm goal</button></div>
    <p className="trust-note"><Icon name="shield" /> Confirming the goal does not move money.</p>
  </section>;
}
