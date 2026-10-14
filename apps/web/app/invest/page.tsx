"use client";

import Link from "next/link";
import { BankingShell } from "../../components/banking/banking-shell";
import { InvestmentView } from "../../components/banking/investment-view";
import { useBankingState } from "../../hooks/use-banking-state";

export default function InvestPage() {
  const banking = useBankingState();
  return <BankingShell active="invest"><div className="banking-page investment-page"><header className="page-heading investment-page-heading"><div><p>Wealth</p><h1>Investments</h1><span>Your portfolio at a glance</span></div><Link className="button bank-primary" href="/chat">Buy / Invest</Link></header><InvestmentView {...banking} /></div></BankingShell>;
}
