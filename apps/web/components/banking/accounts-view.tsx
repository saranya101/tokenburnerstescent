import type { BankStateSnapshotV1 } from "@parlance/contracts";
import { accountLabel, capabilityLabel, formatMinorUnits } from "../../lib/banking-state";

export function AccountsView({ state, loading, error }: { state?: BankStateSnapshotV1 | undefined; loading: boolean; error?: string | undefined }) {
  if (loading && !state) return <LiveStateNotice title="Loading your accounts…" detail="Checking the latest available balances." />;
  if (error && !state) return <LiveStateNotice title="Accounts are temporarily unavailable" detail="We couldn’t load your current bank state. Please refresh and try again." />;
  if (!state || state.accounts.length === 0) return <LiveStateNotice title="No accounts to display" detail="No customer accounts were returned by the bank." />;
  return <section className="account-statement">{state.accounts.map((account) => <article className="account-detail-row" key={account.id}>
    <header><div><h2>{accountLabel(account)}</h2><p>{account.currency} account</p></div><span>{account.status.toLocaleLowerCase()}</span></header>
    <dl><div><dt>Available balance</dt><dd className="primary-money">{formatMinorUnits(account.currency, account.availableMinorUnits)}</dd></div><div><dt>Ledger balance</dt><dd>{formatMinorUnits(account.currency, account.ledgerMinorUnits)}</dd></div><div><dt>Currency</dt><dd>{account.currency}</dd></div><div><dt>Account type</dt><dd>{account.type.toLocaleLowerCase()}</dd></div><div><dt>Status</dt><dd>{account.status.toLocaleLowerCase()}</dd></div></dl>
    <p className="account-capabilities">{[...new Set(account.capabilities.map(capabilityLabel))].join(" · ")}</p>
  </article>)}</section>;
}

export function LiveStateNotice({ title, detail }: { title: string; detail: string }) {
  return <section className="live-state-notice" aria-live="polite"><h2>{title}</h2><p>{detail}</p></section>;
}
