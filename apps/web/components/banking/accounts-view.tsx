import type { BankStateSnapshotV1 } from "@parlance/contracts";
import { accountLabel, capabilityLabel, formatMinorUnits } from "../../lib/banking-state";
import { Icon } from "../ui/icon";

export function AccountsView({ state, loading, error }: { state?: BankStateSnapshotV1 | undefined; loading: boolean; error?: string | undefined }) {
  if (loading && !state) return <LiveStateNotice title="Loading your accounts…" detail="Checking the latest available balances." />;
  if (error && !state) return <LiveStateNotice title="Accounts are temporarily unavailable" detail="We couldn’t load your current bank state. Please refresh and try again." />;
  if (!state || state.accounts.length === 0) return <LiveStateNotice title="No accounts to display" detail="No customer accounts were returned by the bank." />;
  return <div className="live-account-grid">{state.accounts.map((account) => <article className="live-account-card" key={account.id}>
    <div className="live-card-heading"><span><Icon name="wallet" /></span><div><small>{account.currency}</small><h2>{accountLabel(account)}</h2></div><b className={`account-status is-${account.status.toLocaleLowerCase()}`}>{account.status.toLocaleLowerCase()}</b></div>
    <div className="live-balance"><small>Available balance</small><strong>{formatMinorUnits(account.currency, account.availableMinorUnits)}</strong></div>
    <dl><div><dt>Ledger balance</dt><dd>{formatMinorUnits(account.currency, account.ledgerMinorUnits)}</dd></div><div><dt>Account type</dt><dd>{account.type.toLocaleLowerCase()}</dd></div></dl>
    <div className="capability-list" aria-label={`${accountLabel(account)} capabilities`}>{account.capabilities.map((capability) => <span key={capability}>{capabilityLabel(capability)}</span>)}</div>
  </article>)}</div>;
}

export function LiveStateNotice({ title, detail }: { title: string; detail: string }) {
  return <section className="live-state-notice" aria-live="polite"><h2>{title}</h2><p>{detail}</p></section>;
}
