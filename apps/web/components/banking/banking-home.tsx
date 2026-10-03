"use client";

import type { BankStateSnapshotV1 } from "@parlance/contracts";
import Link from "next/link";
import { useBankingState } from "../../hooks/use-banking-state";
import { accountLabel, balancesByCurrency, estimatedHoldingValueMinorUnits, formatMinorUnits } from "../../lib/banking-state";
import { Icon, type IconName } from "../ui/icon";
import { demoBankingData } from "./demo-banking-data";

const actionIcons: Array<{ label: string; icon: IconName; href: string }> = [
  { label: "Pay", icon: "recipient", href: "/chat" },
  { label: "Transfer", icon: "transfer", href: "/chat" },
  { label: "Convert", icon: "fx", href: "/chat" },
  { label: "Invest", icon: "invest", href: "/invest" },
];

export function BankingHome() {
  return <BankingHomeView {...useBankingState()} />;
}

export function BankingHomeView({ state, loading, error }: { state?: BankStateSnapshotV1 | undefined; loading: boolean; error?: string | undefined }) {
  const balances = state ? balancesByCurrency(state) : [];
  const holding = state?.holdings[0];
  const holdingAsset = holding ? state?.assets.find((asset) => asset.id === holding.assetId) : undefined;
  const holdingQuote = holdingAsset ? state?.assetQuotes.find((quote) => quote.assetId === holdingAsset.id && quote.settlementCurrency === holdingAsset.settlementCurrency) : undefined;
  const holdingValue = holding && holdingQuote ? estimatedHoldingValueMinorUnits(holding.quantity, holdingQuote.unitPriceMinor) : undefined;

  return <div className="banking-home">
    <div className="home-heading"><div><p>Good afternoon, Alex</p><h1>Here’s your financial overview.</h1></div><span>{loading ? "Refreshing bank state…" : "Live demo bank state"}</span></div>

    <div className="dashboard-top-grid">
      <section className="balance-hero" aria-labelledby="available-balances-heading">
        <div className="balance-hero-top"><div><span id="available-balances-heading">Available balances</span><div className="currency-balance-list">{balances.map((balance) => <strong key={balance.currency}>{formatMinorUnits(balance.currency, balance.availableMinorUnits)}</strong>)}{balances.length === 0 && <strong>{loading ? "Loading…" : "Unavailable"}</strong>}</div><p>Shown separately by currency. No exchange rate is assumed.</p></div><span className="live-state-badge">Bank state</span></div>
        <svg className="balance-sparkline" viewBox="0 0 520 90" preserveAspectRatio="none" aria-label="Illustrative six-month trend"><path d="M0 74C45 68 60 45 105 52s62 27 103 6 55-39 100-31 68 35 105 13 64-31 107-34" /><path className="sparkline-area" d="M0 74C45 68 60 45 105 52s62 27 103 6 55-39 100-31 68 35 105 13 64-31 107-34V90H0Z" /></svg>
        <div className="balance-period"><span>Illustrative trend</span><span>Not bank history</span></div>
      </section>

      <section className="parlance-feature" aria-labelledby="ask-parlance-heading">
        <div className="feature-orbit" aria-hidden="true"><i /><i /></div><span className="parlance-feature-icon"><Icon name="transfer" /></span><p>Pay &amp; Transfer</p><h2 id="ask-parlance-heading">Tell us what you need to do.</h2><blockquote>“Send John USD 300 and then buy one Apple share.”</blockquote><Link className="button feature-button" href="/chat">Make a payment <Icon name="arrow" /></Link>
      </section>
    </div>

    <section className="dashboard-section" id="accounts"><div className="dashboard-section-heading"><div><h2>Your accounts</h2><p>Available balances from the demo bank</p></div><Link className="section-link" href="/accounts">View all <Icon name="arrow" /></Link></div><div className="account-card-grid">{state?.accounts.map((account, index) => <Link className="account-card" href="/accounts" key={account.id}><span className={`account-card-icon tone-${index}`}><Icon name={account.currency === "USD" ? "fx" : "wallet"} /></span><div><small>{accountLabel(account)}</small><strong>{formatMinorUnits(account.currency, account.availableMinorUnits)}</strong><span>{account.currency} · {account.status.toLocaleLowerCase()}</span></div><span className="account-card-action"><Icon name="arrow" /></span></Link>)}{!state && <p className="inline-state-message">{error ? "Current accounts are temporarily unavailable." : "Loading current accounts…"}</p>}</div></section>

    <div className="dashboard-main-grid">
      <section className="dashboard-surface cashflow-card"><div className="dashboard-section-heading"><div><h2>Monthly cashflow</h2><p>Illustrative only · September 2026</p></div></div><div className="cashflow-metrics"><p><span>Money in</span><strong className="is-positive">S$6,240</strong></p><p><span>Money out</span><strong>S$3,180</strong></p><p><span>Net cashflow</span><strong>S$3,060</strong></p></div><div className="cashflow-chart" role="img" aria-label="Illustrative weekly inflow and outflow bars"><div className="chart-scale"><span>6k</span><span>3k</span><span>0</span></div>{demoBankingData.cashflow.map((week) => <div className="chart-week" key={week.label}><div className="bar-pair"><i style={{ height: `${week.inflow}%` }} /><i style={{ height: `${week.outflow}%` }} /></div><span>{week.label}</span></div>)}</div><div className="chart-legend"><span><i className="inflow" />Money in</span><span><i className="outflow" />Money out</span></div></section>

      <section className="dashboard-surface quick-actions-card" id="actions"><div className="dashboard-section-heading"><div><h2>Quick actions</h2><p>What would you like to do?</p></div></div><div className="quick-actions">{actionIcons.map((action) => <Link href={action.href} key={action.label}><span><Icon name={action.icon} /></span>{action.label}</Link>)}</div><Link className="investment-summary" id="investments" href="/invest"><span><Icon name="invest" /></span><div><small>Investments · demo bank</small><strong>{holding ? `${holding.quantity} ${holdingAsset?.symbol ?? holding.assetId}` : "No holdings yet"}</strong><p>{holdingValue !== undefined && holdingQuote ? `${formatMinorUnits(holdingQuote.settlementCurrency, holdingValue)} estimated value` : "View holdings"}</p></div><span className="summary-arrow"><Icon name="arrow" /></span></Link></section>
    </div>

    <section className="dashboard-surface activity-panel"><div className="dashboard-section-heading"><div><h2>Recent activity</h2><p>Illustrative examples, not bank transactions</p></div></div><div className="activity-table"><div className="activity-table-head"><span>Transaction</span><span>Category</span><span>Status</span><span>Amount</span></div>{demoBankingData.activity.map((activity) => <article key={`${activity.merchant}-${activity.date}`}><span className={`activity-icon is-${activity.kind}`}>{activity.initials}</span><div><strong>{activity.merchant}</strong><small>{activity.date}</small></div><span className="activity-category">{activity.category}</span><span className="activity-status"><i />Example</span><b className={activity.kind === "credit" ? "is-positive" : ""}>{activity.amount}</b></article>)}</div></section>
    <p className="demo-data-note">Hackathon prototype · Account balances and investment holdings come from the authoritative demo bank. Trend, cashflow, and recent activity remain illustrative.</p>
  </div>;
}
