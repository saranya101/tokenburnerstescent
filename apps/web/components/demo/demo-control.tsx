"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DEMO_PRESETS,
  SCENARIO_DETAILS,
  SUPPORTED_SCENARIOS,
  fetchDemoBankState,
  isValidDemoUserId,
  updateDemoScenarios,
  type DemoBankState,
  type DemoScenarioName,
} from "../../lib/demo-control";

const USER_STORAGE_KEY = "parlance.demo.userId";

function diagnostic(error: unknown): string {
  const code = error instanceof Error ? error.message : "MOCK_BANK_UNAVAILABLE";
  if (code === "INVALID_USER_ID") return "Enter a valid demo user ID using letters, numbers, dots, underscores, colons, or hyphens.";
  if (code === "UNSUPPORTED_SCENARIO") return "That scenario is not supported by the mock bank.";
  if (code === "SCENARIO_REQUEST_REJECTED") return "The mock bank rejected the scenario request.";
  return "The mock bank is unavailable. Check that the local mock-bank service is running.";
}

function formatMinorUnits(value: string, currency: string): string {
  try {
    const amount = BigInt(value);
    const sign = amount < 0n ? "-" : "";
    const absolute = amount < 0n ? -amount : amount;
    const integer = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, "0");
    return `${sign}${currency} ${new Intl.NumberFormat("en-SG").format(integer)}.${fraction}`;
  } catch { return `${currency} ${value}`; }
}

export function DemoControl() {
  const [userId, setUserId] = useState("user-1");
  const [rememberUser, setRememberUser] = useState(false);
  const [executionId, setExecutionId] = useState("");
  const [state, setState] = useState<DemoBankState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const loadState = async (targetUserId = userId) => {
    const normalized = targetUserId.trim();
    if (!isValidDemoUserId(normalized)) { setError(diagnostic(new Error("INVALID_USER_ID"))); return; }
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const nextState = await fetchDemoBankState(normalized);
      setState(nextState);
      if (rememberUser) window.localStorage.setItem(USER_STORAGE_KEY, normalized);
      else window.localStorage.removeItem(USER_STORAGE_KEY);
    } catch (nextError) { setError(diagnostic(nextError)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const remembered = window.localStorage.getItem(USER_STORAGE_KEY);
    const initialUserId = remembered && isValidDemoUserId(remembered) ? remembered : "user-1";
    if (remembered) { setUserId(initialUserId); setRememberUser(true); }
    setBusy(true);
    fetchDemoBankState(initialUserId).then(setState).catch((nextError: unknown) => setError(diagnostic(nextError))).finally(() => setBusy(false));
  }, []);

  const applyScenarios = async (scenarios: readonly DemoScenarioName[], message: string) => {
    const normalized = userId.trim();
    if (!isValidDemoUserId(normalized)) { setError(diagnostic(new Error("INVALID_USER_ID"))); return; }
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const refreshed = await updateDemoScenarios(normalized, scenarios);
      setState(refreshed);
      setNotice(message);
      if (rememberUser) window.localStorage.setItem(USER_STORAGE_KEY, normalized);
    } catch (nextError) { setError(diagnostic(nextError)); }
    finally { setBusy(false); }
  };

  const activeScenarios = state?.scenarios ?? [];
  const toggleScenario = (scenario: DemoScenarioName, active: boolean) => {
    const next = active ? [...new Set([...activeScenarios, scenario])] : activeScenarios.filter((item) => item !== scenario);
    void applyScenarios(next, `${SCENARIO_DETAILS[scenario].name} ${active ? "activated" : "reset"}.`);
  };

  return <main className="demo-console">
    <header className="demo-header">
      <div><span className="demo-kicker">Internal tooling</span><h1>Parlance Demo Control</h1><p>Hackathon-only internal tooling</p></div>
      <nav aria-label="Demo links"><Link href="/chat">Open Parlance</Link><Link href="/ops">Open ops</Link></nav>
    </header>

    <div className="demo-warning"><strong>Mock bank only — no real financial system affected.</strong><span>Controls below change existing mock-bank scenarios for one demo user.</span></div>

    <section className="demo-panel demo-target" aria-labelledby="demo-target-heading">
      <div className="demo-panel-heading"><div><span>Target</span><h2 id="demo-target-heading">Demo user and trace links</h2></div>{state && <b>State version {state.stateVersion}</b>}</div>
      <div className="demo-target-grid">
        <label><span>User ID</span><input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="user-1" /></label>
        <button className="demo-button is-primary" type="button" disabled={busy} onClick={() => void loadState()}>{busy ? "Refreshing…" : "Refresh state"}</button>
        <label className="demo-checkbox"><input type="checkbox" checked={rememberUser} onChange={(event) => { setRememberUser(event.target.checked); if (!event.target.checked) window.localStorage.removeItem(USER_STORAGE_KEY); }} />Remember this non-secret demo user ID</label>
        <label><span>Execution ID <small>optional</small></span><input value={executionId} onChange={(event) => setExecutionId(event.target.value)} placeholder="Paste an execution ID" /></label>
        {executionId.trim() && <Link className="demo-button" href={`/execution/${encodeURIComponent(executionId.trim())}`}>Open execution</Link>}
      </div>
      {error && <p className="demo-message is-error" role="alert">{error}</p>}
      {notice && <p className="demo-message is-success" role="status">{notice} State refreshed from the mock bank.</p>}
    </section>

    <section className="demo-panel" aria-labelledby="demo-presets-heading">
      <div className="demo-panel-heading"><div><span>One-click setup</span><h2 id="demo-presets-heading">Hero demo presets</h2></div><small>Each preset replaces the active scenario set.</small></div>
      <div className="demo-preset-grid">{DEMO_PRESETS.map((preset, index) => <article key={preset.id}><span>Preset {String.fromCharCode(65 + index)}</span><h3>{preset.title}</h3><p>{preset.purpose}</p><code>{preset.scenario}</code><button className="demo-button" type="button" disabled={busy} onClick={() => void applyScenarios([preset.scenario], `${preset.title} preset activated.`)}>Activate preset</button></article>)}</div>
    </section>

    <section className="demo-panel" aria-labelledby="demo-scenarios-heading">
      <div className="demo-panel-heading"><div><span>Mock-bank controls</span><h2 id="demo-scenarios-heading">Supported scenarios</h2></div><button className="demo-button" type="button" disabled={busy || activeScenarios.length === 0} onClick={() => void applyScenarios([], "All scenarios reset.")}>Reset all scenarios</button></div>
      <div className="demo-scenario-list">{SUPPORTED_SCENARIOS.map((scenario) => {
        const active = activeScenarios.includes(scenario);
        return <article className={active ? "is-active" : ""} key={scenario}><span className="demo-state-dot" /><div><strong>{SCENARIO_DETAILS[scenario].name}</strong><code>{scenario}</code><p>{SCENARIO_DETAILS[scenario].explanation}</p></div><b>{active ? "Active" : "Inactive"}</b><button className={`demo-button ${active ? "is-reset" : ""}`} type="button" disabled={busy} onClick={() => toggleScenario(scenario, !active)}>{active ? "Reset" : "Activate"}</button></article>;
      })}</div>
      <p className="demo-safety-note">Mock bank only — no real financial system affected.</p>
    </section>

    <section className="demo-panel" aria-labelledby="demo-state-heading">
      <div className="demo-panel-heading"><div><span>Live response</span><h2 id="demo-state-heading">Current mock-bank state</h2></div>{state && <time dateTime={state.capturedAt}>Captured {new Date(state.capturedAt).toLocaleTimeString()}</time>}</div>
      {!state && !busy && <p className="demo-empty">Refresh a valid demo user to inspect mock-bank state.</p>}
      {state && <div className="demo-state-layout">
        <div className="demo-state-card"><span>State version</span><strong>{state.stateVersion}</strong><small>User {state.userId}</small></div>
        <div className="demo-state-section"><h3>Active scenarios</h3><div className="demo-tags">{activeScenarios.length ? activeScenarios.map((scenario) => <code key={scenario}>{scenario}</code>) : <span>None</span>}</div></div>
        <div className="demo-state-section"><h3>Service availability</h3><dl>{Object.entries(state.serviceAvailability).map(([service, available]) => <div key={service}><dt>{service}</dt><dd className={available ? "is-up" : "is-down"}>{available ? "Available" : "Unavailable"}</dd></div>)}</dl></div>
        <div className="demo-state-section"><h3>Accounts</h3><div className="demo-records">{state.accounts.map((account) => <article key={account.id}><span>{account.type} · {account.status}</span><strong>{formatMinorUnits(account.availableMinorUnits, account.currency)}</strong><code>{account.id}</code><small>Ledger {formatMinorUnits(account.ledgerMinorUnits, account.currency)}</small></article>)}</div></div>
        <div className="demo-state-section"><h3>Assets</h3><div className="demo-records">{state.assets.map((asset) => <article key={asset.id}><span>{asset.symbol} · {asset.settlementCurrency}</span><strong>{asset.name}</strong><code>{asset.id}</code><small className={asset.tradable ? "is-up" : "is-down"}>{asset.tradable ? "Tradable" : "Not tradable"}</small></article>)}</div></div>
        <div className="demo-state-section"><h3>FX quote metadata</h3><div className="demo-records">{state.fxQuotes.map((quote) => <article key={quote.id}><span>{quote.fromCurrency} → {quote.toCurrency}</span><strong>Rate {quote.rate}</strong><code>{quote.id}</code><small>Expires {new Date(quote.expiresAt).toLocaleTimeString()}</small></article>)}</div></div>
      </div>}
    </section>
  </main>;
}
