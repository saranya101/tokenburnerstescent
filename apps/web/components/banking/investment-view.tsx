import type { BankStateSnapshotV1 } from "@parlance/contracts";
import { estimatedHoldingValueMinorUnits, formatMinorUnits, formatQuantity } from "../../lib/banking-state";
import { LiveStateNotice } from "./accounts-view";

export function InvestmentView({ state, loading, error }: { state?: BankStateSnapshotV1 | undefined; loading: boolean; error?: string | undefined }) {
  if (loading && !state) return <LiveStateNotice title="Loading your investments…" detail="Checking your current holdings and demo bank quotes." />;
  if (error && !state) return <LiveStateNotice title="Investments are temporarily unavailable" detail="We couldn’t load your current holdings. Please refresh and try again." />;
  if (!state || state.holdings.length === 0) return <LiveStateNotice title="No investments yet" detail="Assets purchased through Pay & Transfer will appear here after bank confirmation." />;
  const totals = new Map<string, bigint>();
  for (const holding of state.holdings) {
    const asset = state.assets.find((candidate) => candidate.id === holding.assetId); const quote = state.assetQuotes.find((candidate) => candidate.assetId === holding.assetId && candidate.settlementCurrency === asset?.settlementCurrency);
    if (quote) totals.set(quote.settlementCurrency, (totals.get(quote.settlementCurrency) ?? 0n) + estimatedHoldingValueMinorUnits(holding.quantity, quote.unitPriceMinor));
  }
  return <div className="investment-statement"><section className="portfolio-summary" aria-label="Portfolio summary"><div><small>Estimated portfolio value</small>{[...totals].map(([currency, value]) => <strong key={currency}>{formatMinorUnits(currency, value)}</strong>)}{totals.size === 0 && <strong>Unavailable</strong>}</div><p>{state.holdings.length} {state.holdings.length === 1 ? "holding" : "holdings"}</p></section><section className="holdings-statement"><div className="statement-heading"><h2>Holdings</h2><p>Current positions held in your account.</p></div>{state.holdings.map((holding) => {
    const asset = state.assets.find((candidate) => candidate.id === holding.assetId);
    const quote = state.assetQuotes.find((candidate) => candidate.assetId === holding.assetId && candidate.settlementCurrency === asset?.settlementCurrency);
    const estimated = quote ? estimatedHoldingValueMinorUnits(holding.quantity, quote.unitPriceMinor) : undefined;
    return <article className="holding-detail-row" key={holding.assetId}>
      <header><div><h3>{asset?.name ?? "Investment holding"}</h3><p>{asset?.symbol ?? "Asset details unavailable"}</p></div><span>{asset ? (asset.tradable ? "Tradable" : "Unavailable") : ""}</span></header>
      <dl>
        <div><dt>Quantity</dt><dd>{formatQuantity(holding.quantity)}</dd></div>
        {quote && estimated !== undefined && <><div><dt>Estimated value</dt><dd className="primary-money">{formatMinorUnits(quote.settlementCurrency, estimated)}</dd></div><div><dt>Current bank quote</dt><dd>{formatMinorUnits(quote.settlementCurrency, quote.unitPriceMinor)} per share</dd></div></>}
        {asset && <div><dt>Settlement currency</dt><dd>{asset.settlementCurrency}</dd></div>}
        {quote && <div><dt>Quote expires</dt><dd>{new Date(quote.expiresAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</dd></div>}
        {asset && <div><dt>Trading status</dt><dd>{asset.tradable ? "Tradable" : "Unavailable"}</dd></div>}
      </dl>
      {!quote && <p className="quote-unavailable">No current demo bank quote is available. Your authoritative holding quantity is still shown.</p>}
    </article>;
  })}</section><p className="investment-disclosure">Prices shown are authoritative demo bank quotes, not live market prices.</p></div>;
}
