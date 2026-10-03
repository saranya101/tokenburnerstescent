"use client";

import { AccountsView } from "../../components/banking/accounts-view";
import { BankingShell } from "../../components/banking/banking-shell";
import { useBankingState } from "../../hooks/use-banking-state";

export default function AccountsPage() {
  const banking = useBankingState();
  return <BankingShell active="accounts"><div className="banking-page"><header className="page-heading"><p>Accounts</p><h1>Your accounts</h1><span>Balances shown directly from the demo bank.</span></header><AccountsView {...banking} /></div></BankingShell>;
}
