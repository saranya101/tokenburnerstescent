"use client";

import { useState, type FormEvent } from "react";

export default function OperatorLoginPage() {
  const [error, setError] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(false);
    const accessToken = String(new FormData(event.currentTarget).get("accessToken") ?? "");
    const response = await fetch("/api/operator/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken }) });
    if (response.ok) window.location.assign("/ops"); else setError(true);
  }
  return <main><h1>Operator access</h1><form onSubmit={submit}><label>Access token<input name="accessToken" type="password" autoComplete="current-password" required /></label><button type="submit">Continue</button></form>{error ? <p role="alert">Operator access was not accepted.</p> : null}</main>;
}
