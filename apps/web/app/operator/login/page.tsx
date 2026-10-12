"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Icon } from "../../../components/ui/icon";
import styles from "./operator-login.module.css";

export default function OperatorLoginPage() {
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(false); setBusy(true);
    const accessToken = String(new FormData(event.currentTarget).get("accessToken") ?? "");
    try {
      const response = await fetch("/api/operator/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken }) });
      if (response.ok) window.location.assign("/ops"); else setError(true);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <main className={styles.shell}><section className={styles.card}>
    <div className={styles.brand}><b>DBS</b><span /><div><strong>Parlance</strong><small>Operations Portal</small></div></div>
    <span className={styles.icon}><Icon name="shield" /></span>
    <h1>Operator access</h1>
    <p className={styles.lead}>Sign in to inspect customer requests and read-only execution evidence. Operator access is separate from customer banking sessions.</p>
    <form className={styles.form} onSubmit={submit}><label>Operator access credential<input name="accessToken" type="password" autoComplete="current-password" required autoFocus /></label><button type="submit" disabled={busy}>{busy ? "Verifying…" : "Continue securely"}</button></form>
    {error ? <p className={styles.error} role="alert">Operator access was not accepted. Check the credential or local server configuration.</p> : null}
    <p className={styles.security}><Icon name="shield" />Credentials are exchanged for a short-lived, HTTP-only operator session and are not stored in browser JavaScript.</p>
    <Link className={styles.back} href="/ops">← Back to operations portal</Link>
  </section></main>;
}
