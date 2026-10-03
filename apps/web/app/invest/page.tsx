"use client";

import { BankingShell } from "../../components/banking/banking-shell";
import { InvestmentView } from "../../components/banking/investment-view";
import { useBankingState } from "../../hooks/use-banking-state";

export default function InvestPage() {
  const banking = useBankingState();
  return <BankingShell active="invest"><div className="banking-page"><header className="page-heading"><p>Invest</p><h1>Your investments</h1><span>Holdings and prices shown from the authoritative demo bank state.</span></header><InvestmentView {...banking} /></div></BankingShell>;
}
