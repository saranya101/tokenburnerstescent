"use client";

import type { BankStateSnapshotV1, CustomerActivityV1 } from "@parlance/contracts";
import Link from "next/link";
import { useBankingState } from "../../hooks/use-banking-state";
import { accountLabel, formatMinorUnits } from "../../lib/banking-state";
import { Icon } from "../ui/icon";

export function ChatBankingSidebar() {
  return <ChatBankingSidebarView {...useBankingState()} />;
}

export function ChatBankingSidebarView({ state, activity, loading, error }: { state?: BankStateSnapshotV1 | undefined; activity?: CustomerActivityV1 | undefined; loading: boolean; error?: string | undefined }) {
  const updatedAt = state ? new Date(state.capturedAt).toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" }) : undefined;
  return <aside className="chat-banking-rail" aria-label="Your banking summary">
    <section className="chat-rail-section" aria-labelledby="chat-accounts-heading">
      <div className="chat-rail-heading"><div><p>Overview</p><h2 id="chat-accounts-heading">Your accounts</h2></div>{updatedAt && <time dateTime={state?.capturedAt}>As of {updatedAt}</time>}</div>
      <div className="chat-account-list">
        {state?.accounts.map((account) => <Link href="/accounts" className="chat-account" key={account.id}>
          <span className="chat-account-icon"><Icon name="accounts" /></span>
          <span><strong>{accountLabel(account)}</strong><small>Available balance</small></span>
          <b>{formatMinorUnits(account.currency, account.availableMinorUnits)}</b>
        </Link>)}
        {state && state.accounts.length === 0 && <RailMessage>No accounts are available.</RailMessage>}
        {!state && loading && <RailLoading label="Loading your accounts" rows={2} />}
        {!state && error && <RailMessage tone="error">Your accounts are temporarily unavailable.</RailMessage>}
      </div>
    </section>

    <section className="chat-rail-section" aria-labelledby="chat-activity-heading">
      <div className="chat-rail-heading"><div><p>Latest</p><h2 id="chat-activity-heading">Recent transactions</h2></div></div>
      <div className="chat-activity-list">
        {activity?.items.slice(0, 4).map((item) => <article className="chat-activity" key={`${item.occurredAt}-${item.description}-${item.accountLabel}`}>
          <span className="chat-activity-icon"><Icon name="transfer" /></span>
          <span><strong>{item.description}</strong><small>{new Date(item.occurredAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", timeZone: "Asia/Singapore" })} · {item.accountLabel}</small></span>
          <b>−{formatMinorUnits(item.amount.currency, item.amount.minorUnits)}</b>
        </article>)}
        {activity && activity.items.length === 0 && <RailMessage>No completed transactions yet.</RailMessage>}
        {!activity && loading && <RailLoading label="Loading recent transactions" rows={3} />}
        {!activity && error && <RailMessage tone="error">Recent transactions are temporarily unavailable.</RailMessage>}
      </div>
    </section>

    <section className="chat-security-note" aria-label="Transaction security">
      <span><Icon name="shield" /></span><div><strong>Review before approval</strong><p>You’ll see the exact plan before passkey confirmation.</p></div>
    </section>
  </aside>;
}

function RailMessage({ children, tone = "empty" }: { children: React.ReactNode; tone?: "empty" | "error" }) {
  return <p className={`chat-rail-message is-${tone}`} role={tone === "error" ? "status" : undefined}>{children}</p>;
}

function RailLoading({ label, rows }: { label: string; rows: number }) {
  return <div className="chat-rail-loading" role="status" aria-label={label}>{Array.from({ length: rows }, (_, index) => <span key={index}><i /><b /></span>)}</div>;
}
