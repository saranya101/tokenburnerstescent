"use client";

import { useEffect, useState, type ReactNode } from "react";

type Status = "loading" | "signed-out" | "authenticated" | "unavailable";

export function WebAuthBoundary({ children, executionAvailable = false }: { children: ReactNode; executionAvailable?: boolean }) {
  const [status, setStatus] = useState<Status>("loading");
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
      {status === "loading" ? <p>Checking your session…</p> : status === "signed-out" ? <><p>Sign in to view your synthetic customer accounts and plans.</p><a href="/api/web-auth/login">Sign in securely</a></> : <p>Customer banking is temporarily unavailable. Please try again later.</p>}
    </section>
  </main>;
}
