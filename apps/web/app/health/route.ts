import { NextResponse } from "next/server";
import { apiBaseUrl } from "../../lib/server-api-auth";

export async function GET() {
  const preview = process.env.PARLANCE_PUBLIC_SAFE_MODE === "true";
  const authenticatedWeb = preview && process.env.PARLANCE_PUBLIC_WEB_ENABLED === "true";
  let backendReady = false;
  try {
    backendReady = (await fetch(`${apiBaseUrl()}/ready`, { cache: "no-store", signal: AbortSignal.timeout(2000) })).ok;
  } catch { /* The public preview can remain available while its backend is unavailable. */ }
  return NextResponse.json({
    status: backendReady || (preview && !authenticatedWeb) ? "ok" : "not_ready",
    mode: authenticatedWeb ? "authenticated-gateway" : preview ? "interface-preview" : "application",
    backend: backendReady ? "ready" : "unavailable",
  }, { status: backendReady || (preview && !authenticatedWeb) ? 200 : 503, headers: { "cache-control": "no-store" } });
}
