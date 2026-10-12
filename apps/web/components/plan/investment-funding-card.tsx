"use client";

import type { BankStateSnapshotV1 } from "@parlance/contracts";
import { useMemo, useState } from "react";
import { accountLabel, formatMinorUnits } from "../../lib/banking-state";
import { Icon } from "../ui/icon";

function reserveMinorUnits(value: string): string | undefined {
  const trimmed = value.trim().replaceAll(",", "");
  if (!trimmed) return undefined;
  if (!/^\d+(?:\.\d{0,2})?$/u.test(trimmed)) throw new Error("Enter an SGD amount with no more than two decimal places.");
  const [major, minor = ""] = trimmed.split(".");
  return (BigInt(major!) * 100n + BigInt(minor.padEnd(2, "0"))).toString();
}

export function InvestmentFundingCard({ state, loading, error, usdAvailableMinorUnits, onReview, onNotNow }: {
  state?: BankStateSnapshotV1 | undefined; loading: boolean; error?: string | undefined; usdAvailableMinorUnits?: bigint | undefined;
  onReview(sourceAccountId: string, minimumSgdReserveMinorUnits?: string): void; onNotNow(): void;
}) {
  const accounts = useMemo(() => state?.accounts.filter((account) => account.status === "ACTIVE" && account.currency === "SGD" && account.capabilities.includes("CONVERT_FX")) ?? [], [state]);
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [reserve, setReserve] = useState("");
  const [validation, setValidation] = useState<string>();
  const selected = sourceAccountId || accounts[0]?.id || "";
  const submit = () => {
    try { setValidation(undefined); onReview(selected, reserveMinorUnits(reserve)); }
    catch (reason) { setValidation(reason instanceof Error ? reason.message : "Check the reserve amount."); }
  };
  return <section className="product-card safe-stop-card investment-funding-card" aria-labelledby="investment-funding-heading">
    <div className="safe-stop-symbol"><Icon name="wallet" /></div>
    <h2 id="investment-funding-heading">Your investment needs USD funding</h2>
    <p className="card-description">Your available USD balance{usdAvailableMinorUnits === undefined ? " is currently insufficient for this purchase" : ` is ${formatMinorUnits("USD", usdAvailableMinorUnits)}, which is insufficient for this purchase`}.</p>
    {loading && !state && <p className="funding-state" role="status">Checking your eligible SGD accounts…</p>}
    {error && !state && <p className="funding-state is-error">Your live SGD balance is temporarily unavailable. No funding option can be prepared.</p>}
    {state && accounts.length === 0 && <p className="funding-state">No active SGD account eligible for currency conversion is available.</p>}
    {accounts.length > 0 && <>
      <p className="funding-question">Would you like to review converting SGD to USD to fund this purchase?</p>
      <label className="funding-field"><span>Funding account</span><select value={selected} onChange={(event) => setSourceAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)} · {formatMinorUnits("SGD", account.availableMinorUnits)} available</option>)}</select></label>
      <label className="funding-field"><span>Minimum SGD reserve <small>Optional</small></span><div className="funding-money-input"><b>S$</b><input inputMode="decimal" value={reserve} onChange={(event) => setReserve(event.target.value)} placeholder="e.g. 1,000.00" aria-describedby="reserve-help" /></div><small id="reserve-help">Leave blank to preserve your existing confirmed constraints without adding a new reserve.</small></label>
      {validation && <p className="funding-validation" role="alert">{validation}</p>}
    </>}
    <div className="card-actions"><button className="button secondary" type="button" onClick={onNotNow}>Not now</button><button className="button bank-primary" type="button" disabled={!selected} onClick={submit}>Review funding options</button></div>
    <p className="trust-note"><Icon name="shield" /> Reviewing funding creates no conversion or purchase. You’ll confirm the updated meaning, review the exact plan, then approve it with your passkey.</p>
  </section>;
}
