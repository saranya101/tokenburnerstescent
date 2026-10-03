import type { BundleSummary } from "../../lib/customer-presentation";
import { Icon } from "../ui/icon";

export function UnderstoodBundleCard({ bundle, onEdit, onConfirm }: { bundle: BundleSummary; onEdit(): void; onConfirm(): void }) {
  return <section className="product-card goal-card" aria-labelledby="understood-bundle-heading">
    <div className="card-heading-row"><div><p className="eyebrow">Check what we understood</p><h2 id="understood-bundle-heading">Your combined request</h2></div></div>
    <ol className="bundle-meaning-list">{bundle.items.map((item) => <li key={item.itemId}>{item.ordered && <strong>Then </strong>}{item.text}</li>)}</ol>
    {bundle.constraints.length > 0 && <div className="goal-rules">{bundle.constraints.map((constraint) => <div className="rule-row" key={constraint}><span className="rule-icon"><Icon name="shield" /></span><div><span>Protected condition</span><strong>{constraint}</strong></div></div>)}</div>}
    <div className="card-actions"><button className="button secondary" type="button" onClick={onEdit}>Make changes</button><button className="button primary" type="button" onClick={onConfirm}>Yes, that’s correct</button></div>
    <p className="trust-note"><Icon name="shield" /> This confirms what you mean. It does not approve a transaction.</p>
  </section>;
}
