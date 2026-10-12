"use client";

import { BankingShell } from "../../components/banking/banking-shell";
import { SavedPayeesView } from "../../components/banking/saved-payees-view";
import { useBankingState } from "../../hooks/use-banking-state";

export default function SavedPayeesPage() {
  const banking = useBankingState();
  return <BankingShell active="pay"><div className="banking-page payees-page"><header className="page-heading"><p>Pay &amp; Transfer</p><h1>Saved payees</h1><span>Choose a saved payee or ask Parlance to make a transfer.</span></header><SavedPayeesView {...banking} /></div></BankingShell>;
}
