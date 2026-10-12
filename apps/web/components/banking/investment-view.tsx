import type { BankStateSnapshotV1, CustomerActivityV1 } from "@parlance/contracts";
import Link from "next/link";
import type { CSSProperties } from "react";
import { accountLabel, estimatedHoldingValueMinorUnits, formatMinorUnits, formatQuantity } from "../../lib/banking-state";
import { Icon } from "../ui/icon";
import { LiveStateNotice } from "./accounts-view";

type InvestmentViewProps = { state?: BankStateSnapshotV1 | undefined; activity?: CustomerActivityV1 | undefined; loading: boolean; error?: string | undefined };
type ValuedHolding = ReturnType<typeof valuedHolding>;

function freshQuote(state: BankStateSnapshotV1, assetId: string) {
  const asset = state.assets.find((candidate) => candidate.id === assetId);
  return state.assetQuotes.find((candidate) => candidate.assetId === assetId && candidate.settlementCurrency === asset?.settlementCurrency && new Date(candidate.expiresAt).getTime() > new Date(state.capturedAt).getTime());
}

function valuedHolding(state: BankStateSnapshotV1, holding: BankStateSnapshotV1["holdings"][number]) {
  const asset = state.assets.find((candidate) => candidate.id === holding.assetId);
  const quote = freshQuote(state, holding.assetId);
  return { holding, asset, quote, marketValue: quote ? estimatedHoldingValueMinorUnits(holding.quantity, quote.unitPriceMinor) : undefined };
}

function allocationPercent(value: bigint, total: bigint): string {
  if (total === 0n) return "0";
  const tenths = value * 1000n / total;
  return `${tenths / 10n}${tenths % 10n === 0n ? "" : `.${tenths % 10n}`}`;
}

function AssetIdentity({ item }: { item: ValuedHolding }) {
  return <div className="wealth-asset"><span className="asset-mark">{item.asset?.symbol.slice(0, 2) ?? "—"}</span><span><strong>{item.asset?.name ?? "Investment holding"}</strong><small>{item.asset?.symbol ?? "Asset details unavailable"} · {item.asset?.assetType ?? "Unclassified"}</small></span></div>;
}

export function InvestmentView({ state, activity, loading, error }: InvestmentViewProps) {
  if (loading && !state) return <LiveStateNotice title="Loading your investments…" detail="Checking your current holdings, accounts and demo bank quotes." />;
  if (error && !state) return <LiveStateNotice title="Investments are temporarily unavailable" detail="We couldn’t load your current holdings. Please refresh and try again." />;
  if (!state) return <LiveStateNotice title="Investments are temporarily unavailable" detail="No authoritative customer state was returned by the bank." />;

  const valued = state.holdings.map((holding) => valuedHolding(state, holding));
  const totals = new Map<string, bigint>();
  for (const item of valued) if (item.quote && item.marketValue !== undefined) totals.set(item.quote.settlementCurrency, (totals.get(item.quote.settlementCurrency) ?? 0n) + item.marketValue);
  const featured = valued[0];
  const oneCurrency = totals.size === 1 ? [...totals][0] : undefined;
  const fullyValued = valued.length > 0 && valued.every((item) => item.marketValue !== undefined && item.quote?.settlementCurrency === oneCurrency?.[0]);
  const investmentActivity = activity?.items.filter((item) => /^Buy\s/iu.test(item.description)) ?? [];
  const availableAssets = state.assets.filter((asset) => asset.tradable);

  return <div className="wealth-dashboard wealth-dashboard-final">
    <nav className="wealth-tabs" aria-label="Investment sections"><a href="#overview" className="is-active">Overview</a><a href="#holdings">Holdings</a><a href="#explore">Explore &amp; Invest</a><a href="#activity">Activity</a></nav>

    <section className="wealth-main-grid" id="overview">
      <article className="wealth-portfolio-card" aria-labelledby="portfolio-heading"><div className="portfolio-card-top"><span>Portfolio value</span><small><i /> Authoritative bank state</small></div><h2 id="portfolio-heading">{[...totals].map(([currency, value]) => <span key={currency}>{formatMinorUnits(currency, value)}</span>)}{totals.size === 0 && <span>Unavailable</span>}</h2><p>Current market value using fresh synthetic-bank investment quotes.</p><div className="portfolio-value-rule" /><dl><div><dt>Holdings</dt><dd>{state.holdings.length}</dd></div><div><dt>Reporting currency</dt><dd>{oneCurrency?.[0] ?? "Kept separate"}</dd></div><div><dt>Cost basis</dt><dd>Not available</dd></div><div><dt>Unrealised P/L</dt><dd>Not available</dd></div></dl><footer><Icon name="invest" /><span>Historical valuation data is not available, so no performance curve or daily return is shown.</span></footer></article>

      <article className="wealth-featured-card" id="holdings" aria-labelledby="featured-heading">{featured ? <><header><span>Featured holding</span><b className={featured.asset?.tradable ? "is-available" : ""}>{featured.asset?.tradable ? "Available" : "Unavailable"}</b></header><div className="featured-identity"><span className="featured-asset-mark">{featured.asset?.symbol.slice(0, 2) ?? "—"}</span><div><h2 id="featured-heading">{featured.asset?.name ?? "Investment holding"}</h2><p>{featured.asset?.symbol ?? "Unknown symbol"} · {featured.asset?.assetType ?? "Unclassified"}</p></div></div><dl><div><dt>Quantity held</dt><dd>{formatQuantity(featured.holding.quantity)}</dd></div><div><dt>Current value</dt><dd>{featured.quote && featured.marketValue !== undefined ? formatMinorUnits(featured.quote.settlementCurrency, featured.marketValue) : "Unavailable"}</dd></div><div><dt>Bank quote</dt><dd>{featured.quote ? `${formatMinorUnits(featured.quote.settlementCurrency, featured.quote.unitPriceMinor)} / share` : "No fresh quote"}</dd></div></dl><Link className="button bank-primary" href="/chat">Buy more <Icon name="arrow" /></Link></> : <div className="featured-empty"><span><Icon name="invest" /></span><h2 id="featured-heading">No investments yet</h2><p>Your first confirmed investment will appear here.</p><Link className="button bank-primary" href="/chat">Buy / Invest</Link></div>}</article>

      <article className="wealth-allocation-card" aria-labelledby="allocation-heading"><header><span>Portfolio</span><h2 id="allocation-heading">Allocation</h2></header>{fullyValued && oneCurrency ? <><div className="allocation-donut" style={{ "--allocation": "100%" } as CSSProperties}><span><strong>100%</strong><small>{oneCurrency[0]}</small></span></div><div className="allocation-legend">{valued.map((item) => <div key={item.holding.assetId}><i /><span>{item.asset?.symbol ?? "Holding"}</span><b>{allocationPercent(item.marketValue!, oneCurrency[1])}%</b></div>)}</div></> : <div className="allocation-unavailable"><Icon name="invest" /><p>{valued.length === 0 ? "No holdings to allocate." : "Allocation needs fresh quotes in one reporting currency."}</p></div>}</article>

      <article className="wealth-accounts-card" aria-labelledby="accounts-heading"><header><span>Available cash</span><h2 id="accounts-heading">Investment accounts</h2></header><div>{state.accounts.filter((account) => account.status === "ACTIVE" && (account.currency === "SGD" || account.currency === "USD")).map((account) => <section key={account.id}><span className={account.currency === "SGD" ? "is-sgd" : "is-usd"}><Icon name="wallet" /></span><div><strong>{accountLabel(account)}</strong><small>{account.type.toLocaleLowerCase()}</small></div><b>{formatMinorUnits(account.currency, account.availableMinorUnits)}</b></section>)}</div></article>
    </section>

    {valued.length > 1 && <section className="wealth-card wealth-holdings" aria-labelledby="all-holdings-heading"><header><div><p>Your portfolio</p><h2 id="all-holdings-heading">All holdings</h2></div></header><div className="wealth-table"><div className="wealth-table-head"><span>Asset</span><span>Quantity</span><span>Current quote</span><span>Market value</span><span>Status</span></div>{valued.map((item) => <article key={item.holding.assetId}><AssetIdentity item={item} /><b data-label="Quantity">{formatQuantity(item.holding.quantity)}</b><span data-label="Current quote">{item.quote ? `${formatMinorUnits(item.quote.settlementCurrency, item.quote.unitPriceMinor)} / share` : "Unavailable"}</span><b data-label="Market value">{item.quote && item.marketValue !== undefined ? formatMinorUnits(item.quote.settlementCurrency, item.marketValue) : "Unavailable"}</b><span data-label="Status" className={item.asset?.tradable ? "wealth-status" : "wealth-status is-unavailable"}>{item.asset?.tradable ? "Tradable" : "Unavailable"}</span></article>)}</div></section>}

    <section className="wealth-card market-pulse" id="explore" aria-labelledby="market-pulse-heading"><header><div><p>Informational watchlist</p><h2 id="market-pulse-heading">Market watch</h2></div><Link className="wealth-text-action" href="/chat">Explore &amp; invest <Icon name="arrow" /></Link></header><div className="market-boundary"><Icon name="shield" /><span>These synthetic-bank quotes are informational here and remain separate from plan approval. The compiler independently obtains authoritative execution quotes.</span></div><div className="market-pulse-strip">{availableAssets.map((asset) => { const quote = freshQuote(state, asset.id); return <article key={asset.id}><div><span className="asset-mark">{asset.symbol.slice(0, 2)}</span><span><strong>{asset.name}</strong><small>{asset.symbol} · {asset.assetType}</small></span></div><b>{quote ? formatMinorUnits(quote.settlementCurrency, quote.unitPriceMinor) : "Quote unavailable"}</b><small>{quote ? `Valid to ${new Date(quote.expiresAt).toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" })}` : "No executable quote"}</small></article>; })}{availableAssets.length === 0 && <p className="wealth-empty">No tradable assets are currently available.</p>}</div><p className="market-source-note">Market-wide activity, gainers, losers and price history are unavailable because no licensed public market-data feed is configured.</p></section>

    <section className="wealth-card investment-activity-wide" id="activity" aria-labelledby="activity-heading"><header><div><p>Completed transactions</p><h2 id="activity-heading">Recent investment activity</h2></div></header><div className="investment-activity-head"><span>Date</span><span>Investment</span><span>Account</span><span>Amount</span><span>Status</span></div><div className="investment-activity-list">{investmentActivity.map((item) => <article key={`${item.occurredAt}:${item.description}`}><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Singapore" })}</time><div><strong>{item.description}</strong><small>Confirmed investment purchase</small></div><small>{item.accountLabel}</small><b>−{formatMinorUnits(item.amount.currency, item.amount.minorUnits)}</b><span>Completed</span></article>)}{activity && investmentActivity.length === 0 && <p className="wealth-empty">No completed investment activity yet.</p>}{!activity && <p className="wealth-empty">{error ? "Investment activity is temporarily unavailable." : "Loading investment activity…"}</p>}</div></section>
    <p className="investment-disclosure">Portfolio values use authoritative synthetic-bank quotes, not external market prices. Historical performance, cost basis and investment recommendations are not provided.</p>
  </div>;
}
