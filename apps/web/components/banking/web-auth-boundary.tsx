"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

type Status = "loading" | "signed-out" | "authenticated" | "unavailable";

export function WebAuthBoundary({ children, executionAvailable = false }: { children: ReactNode; executionAvailable?: boolean }) {
  const [status, setStatus] = useState<Status>("loading");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/web-auth/${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { code?: string };
        setError(result.code === "TOO_MANY_ATTEMPTS" ? "Too many attempts. Please try again in 15 minutes." : result.code === "ACCOUNT_UNAVAILABLE" ? "Unable to create this account. If you already registered, log in." : result.code === "INVALID_CREDENTIALS" ? "Enter a valid email and a password of 10–128 characters." : result.code === "LOGIN_FAILED" ? "Email or password is incorrect." : "Sign-in is temporarily unavailable. Please try again.");
        return;
      }
      setPassword(""); window.location.reload();
    } catch { setError("Couldn’t connect. Your details are still here; please try again."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch("/api/web-auth/session", { cache: "no-store" });
        if (active) setStatus(response.ok ? "authenticated" : response.status === 401 ? "signed-out" : "unavailable");
      } catch { if (active) setStatus("unavailable"); }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 5 * 60 * 1000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  if (status === "authenticated") return <><div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 20px" }}><span>{executionAvailable ? "Synthetic banking · Passkey required for transactions" : "Plan review only · Financial execution unavailable"}</span><button type="button" onClick={async () => {
    const response = await fetch("/api/web-auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (response.ok) { setStatus("signed-out"); window.location.assign("/"); }
  }}>Sign out</button></div>{children}</>;

  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#f7f8fa" }}>
    <section style={{ maxWidth: 440, width: "100%", padding: 32, borderRadius: 18, background: "white", boxShadow: "0 10px 35px #14213818" }}>
      <h1>Parlance banking</h1>
      {status === "loading" ? <p>Checking your session…</p> : status === "signed-out" ? <>
        <p>{mode === "signup" ? "Create your Parlance account" : "Welcome back. Log in to Parlance."}</p>
        <p style={{ color: "#64717f", fontSize: 14 }}>Use any email address, including Gmail. No email verification is required. New accounts start with an empty synthetic banking profile.</p>
        <form onSubmit={submit} className="clarification-answer">
          <label htmlFor="auth-email">Email address</label>
          <input id="auth-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} style={{ width: "100%", marginBottom: 16 }} />
          <label htmlFor="auth-password">Password</label>
          <input id="auth-password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={10} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} style={{ width: "100%", marginBottom: 12 }} />
          <p style={{ fontSize: 13, color: "#64717f" }}>Use 10–128 characters.</p>
          {error && <p role="alert" className="form-error">{error}</p>}
          <button className="button bank-primary" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}</button>
        </form>
        <button type="button" className="text-button" disabled={busy} onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); setPassword(""); }}>{mode === "login" ? "New to Parlance? Create an account" : "Already registered? Log in"}</button>
      </> : <><p>Customer banking is temporarily unavailable. Please try again later.</p><button type="button" onClick={() => window.location.reload()}>Try again</button></>}
    </section>
  </main>;
}
