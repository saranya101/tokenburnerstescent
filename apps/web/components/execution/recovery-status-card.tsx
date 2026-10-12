import { Icon } from "../ui/icon";

export function RecoveryStatusCard({ onCheckStatus }: { onCheckStatus(): void }) {
  return <section className="product-card safe-stop-card" aria-live="polite">
    <div className="safe-stop-symbol"><Icon name="shield" /></div>
    <h2>We couldn’t confirm the latest status yet</h2>
    <p className="card-description">Please don’t repeat this request while we check. Your existing transaction is still being tracked.</p>
    <div className="card-actions"><button className="button bank-primary" type="button" onClick={onCheckStatus}>Check status</button></div>
  </section>;
}
