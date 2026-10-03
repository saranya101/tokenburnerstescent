"use client";

import type { BankStateSnapshotV1, CustomerActivityV1 } from "@parlance/contracts";
import Link from "next/link";
import { useBankingState } from "../../hooks/use-banking-state";
import { accountLabel, estimatedHoldingValueMinorUnits, formatMinorUnits, formatQuantity } from "../../lib/banking-state";
import { Icon } from "../ui/icon";

export function BankingHome() {
  return <BankingHomeView {...useBankingState()} />;
}

export function BankingHomeView({ state, activity, loading, error }: { state?: BankStateSnapshotV1 | undefined; activity?: CustomerActivityV1 | undefined; loading: boolean; error?: string | undefined }) {
  const capturedAt = state ? new Date(state.capturedAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Singapore" }) : undefined;
  return <div className="banking-home bank-overview">
    <header className="home-heading"><div><p>Good afternoon, Alex</p><h1>Your financial overview</h1></div><span>{loading ? "Refreshing…" : capturedAt ? `Last updated ${capturedAt}` : ""}</span></header>

    <div className="bank-overview-grid">
      <section className="bank-section account-overview" id="accounts" aria-labelledby="home-accounts-heading">
        <div className="bank-section-heading"><div><h2 id="home-accounts-heading">Your accounts</h2><p>Available balances from your accounts.</p></div></div>
        <div className="bank-list">{state?.accounts.map((account) => <Link className="bank-account-row" href="/accounts" key={account.id}><div><strong>{accountLabel(account)}</strong><small>Available balance</small></div><b>{formatMinorUnits(account.currency, account.availableMinorUnits)}</b><span>{account.status.toLocaleLowerCase()}</span><Icon name="arrow" /></Link>)}{!state && <p className="bank-empty-row">{error ? "Your accounts are temporarily unavailable." : "Loading your accounts…"}</p>}</div>
        <Link className="bank-text-link" href="/accounts">View all accounts <Icon name="arrow" /></Link>
      </section>

      <section className="payment-entry" aria-labelledby="pay-transfer-heading"><span className="payment-entry-icon"><Icon name="transfer" /></span><h2 id="pay-transfer-heading">Pay &amp; Transfer</h2><p>Tell us what you need to do.</p><blockquote>“Send John USD 300 and then buy one Apple share, but keep at least S$1,000 available.”</blockquote><Link className="button bank-primary" href="/chat">Make a payment <Icon name="arrow" /></Link></section>
    </div>

    <section className="bank-section holdings-overview" id="investments" aria-labelledby="home-investments-heading">
      <div className="bank-section-heading"><div><h2 id="home-investments-heading">Investments</h2><p>Your holdings and current bank quotes.</p></div><Link className="bank-text-link" href="/invest">View investments <Icon name="arrow" /></Link></div>
      <div className="bank-table holdings-table"><div className="bank-table-head"><span>Asset</span><span>Symbol</span><span>Quantity</span><span>Current bank quote</span><span>Estimated value</span></div>{state?.holdings.map((holding) => {
        const asset = state.assets.find((candidate) => candidate.id === holding.assetId);
        const quote = state.assetQuotes.find((candidate) => candidate.assetId === holding.assetId && candidate.settlementCurrency === asset?.settlementCurrency);
        const estimated = quote ? estimatedHoldingValueMinorUnits(holding.quantity, quote.unitPriceMinor) : undefined;
        return <Link className="bank-table-row" href="/invest" key={holding.assetId}><strong>{asset?.name ?? "Investment holding"}</strong><span data-label="Symbol">{asset?.symbol ?? "—"}</span><span data-label="Quantity">{formatQuantity(holding.quantity)}</span><span data-label="Current bank quote">{quote ? formatMinorUnits(quote.settlementCurrency, quote.unitPriceMinor) : "Unavailable"}</span><b data-label="Estimated value">{quote && estimated !== undefined ? formatMinorUnits(quote.settlementCurrency, estimated) : "Unavailable"}</b></Link>;
      })}{state && state.holdings.length === 0 && <p className="bank-empty-row">No investments yet.</p>}{!state && <p className="bank-empty-row">Loading your investments…</p>}</div>
    </section>

    <section className="bank-section activity-overview" aria-labelledby="recent-activity-heading">
      <div className="bank-section-heading"><div><h2 id="recent-activity-heading">Recent activity</h2><p>Your latest completed transactions across all accounts.</p></div></div>
      <div className="bank-table activity-statement"><div className="bank-table-head"><span>Date</span><span>Transaction</span><span>Account</span><span>Amount</span><span>Status</span></div>{activity?.items.map((item) => <div className="bank-table-row" key={`${item.occurredAt}-${item.description}`}><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Singapore" })}</time><strong data-label="Transaction">{item.description}</strong><span data-label="Account">{item.accountLabel}</span><b data-label="Amount">−{formatMinorUnits(item.amount.currency, item.amount.minorUnits)}</b><span data-label="Status">Completed</span></div>)}{activity && activity.items.length === 0 && <p className="bank-empty-row">No completed activity yet.</p>}{!activity && <p className="bank-empty-row">{error ? "Recent activity is temporarily unavailable." : "Loading recent activity…"}</p>}</div>
    </section>

    <aside className="bank-utility-strip"><div><strong>Do more with DBS digibank</strong><p>Make payments, transfer funds, convert currencies or invest — all in one place.</p></div><Link className="bank-text-link" href="/chat">Explore features <Icon name="arrow" /></Link></aside>
  </div>;
}
