import type { PlanPresentation } from "../chat/presentation";
import { Icon } from "../ui/icon";
import { PlanRoute } from "./plan-route";

export function FinancialPlanPreview({ scenario, onApprove, onCancel, onRefreshQuote, busy = false, quoteLoading = false, reviewReady = true, authorizationAvailable = true }: { scenario: PlanPresentation; onApprove(): void; onCancel(): void; onRefreshQuote?: () => void; busy?: boolean; quoteLoading?: boolean; reviewReady?: boolean; authorizationAvailable?: boolean }) {
  const amount = scenario.goal.details.find((item) => item.label === "Amount")?.value;
  const recipient = scenario.goal.details.find((item) => item.label === "To" || item.label === "Recipient")?.value;
  const combined = scenario.transactionKind === "COMBINED";
  const investment = scenario.transactionKind === "INVESTMENT" || scenario.goal.details.some((item) => item.label === "Investment");
  const asset = scenario.goal.details.find((item) => item.label === "Investment")?.value;
  const quantity = scenario.goal.details.find((item) => item.label === "Quantity")?.value;
  const noun = combined ? "combined transaction" : investment ? "investment" : "payment";
  return <section className={`product-card plan-card ${investment ? "investment-plan-card" : ""}`} aria-labelledby="plan-heading">
    <div className="card-heading-row"><div><p className="eyebrow">{combined ? "Combined transaction" : investment ? "Investment details" : "Payment details"}</p><h2 id="plan-heading">{scenario.planTitle}</h2></div></div>
    <p className="card-description">{scenario.planSummary}</p>
    {investment && <div className="investment-asset-hero"><span className="investment-asset-mark">{asset?.slice(0, 2).toLocaleUpperCase() ?? "IN"}</span><div><small>Investment</small><strong>{asset}</strong><p>{quantity} {quantity === "1" ? "share" : "shares"}</p></div></div>}
    <div className="payment-hero"><small>{amount && recipient ? "You’ll send" : "You asked to"}</small><strong>{amount && recipient ? amount : scenario.goal.title}</strong>{recipient && <span>to {recipient}</span>}</div>
    {scenario.funding.length > 0 && <section className="funding-panel" aria-labelledby="funding-heading"><h3 id="funding-heading">How this {noun} will be funded</h3>{scenario.funding.map((item) => <div className="funding-row" key={`${item.account}:${item.amount}`}><span><Icon name="wallet" /></span><div><strong>{item.account}</strong><small>{item.detail}</small></div><b>{item.amount}</b></div>)}</section>}
    <div className="plan-composition">
      <div className="plan-route-column"><h3 className="section-heading">What will happen</h3><PlanRoute scenario={scenario} /></div>
      <aside className="transaction-summary" aria-label="Transaction summary"><div className="summary-heading"><span><Icon name="wallet" /></span><div><small>{combined || investment ? "Projected outcome" : "Payment"}</small><h3>Summary</h3></div></div><dl>{scenario.goal.details.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}{scenario.projectedBalances?.map((balance) => <div key={`projected:${balance.account}`}><dt>{balance.account} after</dt><dd>{balance.amount}</dd></div>)}{scenario.projectedHoldings?.map((holding) => <div key={`holding:${holding.asset}`}><dt>{holding.asset} holding after</dt><dd>{holding.quantity} {holding.quantity === "1" ? "share" : "shares"}</dd></div>)}</dl>{scenario.preservedConstraints[0] && <div className="summary-condition"><Icon name="shield" /><div><small>Protected by this plan</small><strong>{scenario.preservedConstraints[0]}</strong></div></div>}</aside>
    </div>
    {scenario.preservedConstraints.length > 1 && <div className="preserved-panel"><p>Also protected</p>{scenario.preservedConstraints.slice(1).map((constraint) => <span key={constraint}><Icon name="check" />{constraint}</span>)}</div>}
    <div className="approval-callout"><Icon name="shield" /><div>{authorizationAvailable ? <><strong>Nothing moves until you confirm with your passkey.</strong><p>If these {noun} details change, you’ll be asked to review them again.</p></> : <><strong>Plan review only. Financial authorization is unavailable.</strong><p>No payment, conversion, or investment can be executed from this public demonstration.</p></>}</div></div>
    {scenario.validUntil && <p className="plan-expiry"><Icon name="warning" /> Quotes valid until {new Date(scenario.validUntil).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Singapore" })}. If they change or expire, you’ll review a new plan.</p>}
    <div className="card-actions"><button className="button secondary" type="button" onClick={onCancel} disabled={busy}>{investment || combined ? "Make changes" : "Cancel"}</button>{(authorizationAvailable || !reviewReady && onRefreshQuote) && <button className="button bank-primary" type="button" onClick={reviewReady ? onApprove : onRefreshQuote} disabled={busy || quoteLoading || (!reviewReady && !onRefreshQuote)}>{busy ? "Waiting for passkey…" : quoteLoading ? "Checking quote…" : reviewReady ? "Confirm with passkey" : "Refresh quote"}</button>}</div>
  </section>;
}
