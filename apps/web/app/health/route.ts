import { NextResponse } from "next/server";
import { apiBaseUrl } from "../../lib/server-api-auth";

export async function GET() {
  const preview = process.env.PARLANCE_PUBLIC_SAFE_MODE === "true";
  let backendReady = false;
  try {
    backendReady = (await fetch(`${apiBaseUrl()}/ready`, { cache: "no-store", signal: AbortSignal.timeout(2000) })).ok;
  } catch { /* The public preview can remain available while its backend is unavailable. */ }
  return NextResponse.json({
    status: backendReady || preview ? "ok" : "not_ready",
    mode: preview ? "interface-preview" : "application",
    backend: backendReady ? "ready" : "unavailable",
  }, { status: backendReady || preview ? 200 : 503, headers: { "cache-control": "no-store" } });
}
