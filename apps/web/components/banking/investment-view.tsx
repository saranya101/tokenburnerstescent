import type { BankStateSnapshotV1 } from "@parlance/contracts";
import { estimatedHoldingValueMinorUnits, formatMinorUnits } from "../../lib/banking-state";
import { Icon } from "../ui/icon";
import { LiveStateNotice } from "./accounts-view";

export function InvestmentView({ state, loading, error }: { state?: BankStateSnapshotV1 | undefined; loading: boolean; error?: string | undefined }) {
  if (loading && !state) return <LiveStateNotice title="Loading your investments…" detail="Checking your current holdings and demo bank quotes." />;
  if (error && !state) return <LiveStateNotice title="Investments are temporarily unavailable" detail="We couldn’t load your current holdings. Please refresh and try again." />;
  if (!state || state.holdings.length === 0) return <LiveStateNotice title="No investments yet" detail="Assets purchased through Pay & Transfer will appear here after bank confirmation." />;
  return <div className="investment-holding-grid">{state.holdings.map((holding) => {
    const asset = state.assets.find((candidate) => candidate.id === holding.assetId);
    const quote = state.assetQuotes.find((candidate) => candidate.assetId === holding.assetId && candidate.settlementCurrency === asset?.settlementCurrency);
    const estimated = quote ? estimatedHoldingValueMinorUnits(holding.quantity, quote.unitPriceMinor) : undefined;
    return <article className="investment-holding-card" key={holding.assetId}>
      <div className="live-card-heading"><span><Icon name="invest" /></span><div><small>{asset?.symbol ?? holding.assetId}</small><h2>{asset?.name ?? "Investment holding"}</h2></div>{asset && <b className={`account-status ${asset.tradable ? "is-active" : "is-closed"}`}>{asset.tradable ? "tradable" : "unavailable"}</b>}</div>
      <div className="holding-quantity"><small>Quantity</small><strong>{holding.quantity} {asset?.symbol ?? "units"}</strong></div>
      <dl>
        {asset && <div><dt>Settlement currency</dt><dd>{asset.settlementCurrency}</dd></div>}
        {quote && estimated !== undefined && <><div><dt>Current demo bank quote</dt><dd>{formatMinorUnits(quote.settlementCurrency, quote.unitPriceMinor)} per unit</dd></div><div><dt>Estimated holding value</dt><dd>{formatMinorUnits(quote.settlementCurrency, estimated)}</dd></div><div><dt>Quote expires</dt><dd>{new Date(quote.expiresAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</dd></div></>}
      </dl>
      {!quote && <p className="quote-unavailable">No current demo bank quote is available. Your authoritative holding quantity is still shown.</p>}
    </article>;
  })}</div>;
}
