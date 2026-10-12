"use client";

import type { BankStateSnapshotV1 } from "@parlance/contracts";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "../ui/icon";
import { LiveStateNotice } from "./accounts-view";

type Beneficiary = BankStateSnapshotV1["beneficiaries"][number];

export function matchingPayees(payees: readonly Beneficiary[], query: string): Beneficiary[] {
  const normalized = query.trim().toLocaleLowerCase();
  return [...payees]
    .filter((payee) => normalized.length === 0 || payee.name.toLocaleLowerCase().includes(normalized))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function SavedPayeesView({ state, loading, error }: { state?: BankStateSnapshotV1 | undefined; loading: boolean; error?: string | undefined }) {
  const [query, setQuery] = useState("");
  const payees = useMemo(() => matchingPayees(state?.beneficiaries ?? [], query), [state?.beneficiaries, query]);
  if (loading && !state) return <LiveStateNotice title="Loading your saved payees…" detail="Checking your latest beneficiary list." />;
  if (error && !state) return <LiveStateNotice title="Saved payees are temporarily unavailable" detail="We couldn’t load your beneficiary list. Please refresh and try again." />;
  if (!state) return <LiveStateNotice title="Saved payees are temporarily unavailable" detail="No authoritative customer state was returned by the bank." />;

  return <div className="saved-payees">
    <label className="payee-search"><span className="sr-only">Search saved payees</span><Icon name="search" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search saved payees" /></label>
    {state.beneficiaries.length === 0 ? <LiveStateNotice title="No saved payees" detail="Your saved banking beneficiaries will appear here when available." /> : payees.length === 0 ? <LiveStateNotice title="No matching payees" detail={`No saved payee matches “${query.trim()}”.`} /> : <section className="payee-list" aria-label="Saved payees">
      {payees.map((payee) => <article className="payee-row" key={payee.id}>
        <span className="payee-avatar" aria-hidden="true">{initials(payee.name)}</span>
        <div className="payee-identity"><h2>{payee.name}</h2><p>{payee.supportedCurrencies.length ? `${payee.supportedCurrencies.join(", ")} transfers` : "Transfer currency unavailable"}</p></div>
        <span className={`payee-status ${payee.status !== "ACTIVE" ? "is-unavailable" : ""}`}>{payee.status === "ACTIVE" ? "Active" : "Unavailable"}</span>
        {payee.status === "ACTIVE" ? <Link className="button secondary payee-send" href={{ pathname: "/chat", query: { draft: `Send money to ${payee.name}` } }}>Send money <Icon name="arrow" /></Link> : <button className="button secondary payee-send" type="button" disabled>Unavailable</button>}
      </article>)}
    </section>}
    <p className="payee-safety-note"><Icon name="shield" /> Selecting a payee only prepares an editable request. You still choose the amount, confirm the meaning and approve the exact plan before money moves.</p>
  </div>;
}

function initials(name: string): string {
  return name.split(/\s+/u).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toLocaleUpperCase();
}
