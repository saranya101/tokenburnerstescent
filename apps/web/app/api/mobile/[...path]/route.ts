import { NextRequest, NextResponse } from "next/server";
import { apiBaseUrl, CUSTOMER_PRINCIPAL_HEADER, INTERNAL_TOKEN_HEADER, webSecurityConfigurationValid } from "../../../../lib/server-api-auth";
import { createMobileSession, mobileSessionCustomer, revokeMobileSession, rotateMobileSession, verifiedMobileIdentity } from "../../../../lib/mobile-auth";

// Only pre-authorization customer routes are reachable through this gateway.
const GET_ROUTES = [/^session$/u, /^customer\/(?:state|activity|operations|journeys)$/u, /^executions\/[^/]+\/detail$/u];
const POST_ROUTES = [
  /^session\/(?:exchange|refresh|logout)$/u,
  /^messages$/u, /^clarifications\/[^/]+\/answer$/u, /^bundle-clarifications\/[^/]+\/answer$/u,
  /^goal-candidates\/[^/]+\/confirm$/u, /^goal-bundle-candidates\/[^/]+\/confirm$/u,
  /^goals\/[^/]+\/(?:compile|funding-candidate)$/u, /^goal-bundles\/[^/]+\/compile$/u,
];

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }, method: "GET" | "POST") {
  const parts = (await context.params).path;
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("%") || part.includes("\\"))) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const path = parts.join("/");
  if (!(method === "GET" ? GET_ROUTES : POST_ROUTES).some((pattern) => pattern.test(path))) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  if (method === "POST" && path.startsWith("session/")) {
    try {
      if (path === "session/exchange") {
        const identity = await verifiedMobileIdentity(request.headers.get("authorization"));
        if (!identity) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
        return NextResponse.json(await createMobileSession(identity), { headers: { "cache-control": "no-store" } });
      }
      const input = await request.text();
      if (input.length > 1024) return NextResponse.json({ code: "REQUEST_TOO_LARGE" }, { status: 413 });
      let value: unknown;
      try { value = JSON.parse(input); } catch { return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 }); }
      const refreshToken = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).refreshToken : undefined;
      if (typeof refreshToken !== "string") return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
      if (path === "session/refresh") {
        const rotated = await rotateMobileSession(refreshToken);
        return rotated ? NextResponse.json(rotated, { headers: { "cache-control": "no-store" } }) : NextResponse.json({ code: "SESSION_EXPIRED" }, { status: 401 });
      }
      await revokeMobileSession(refreshToken);
      return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
    } catch { return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 }); }
  }
  const internalToken = process.env.PARLANCE_INTERNAL_API_TOKEN?.trim();
  if (!internalToken || !webSecurityConfigurationValid()) return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 });
  let userId: string | undefined;
  try { userId = await mobileSessionCustomer(request.headers.get("authorization")); }
  catch { return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 }); }
  if (!userId) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
  if (path === "session") return NextResponse.json({ authenticated: true, userId }, { headers: { "cache-control": "no-store" } });
  let body: string | undefined;
  if (method === "POST") {
    try { body = JSON.stringify(await request.json()); } catch { return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 }); }
    if (body.length > 32768) return NextResponse.json({ code: "REQUEST_TOO_LARGE" }, { status: 413 });
  }
  try {
    const response = await fetch(`${apiBaseUrl()}/v1/${path}`, {
      method, cache: "no-store", headers: { [INTERNAL_TOKEN_HEADER]: internalToken, [CUSTOMER_PRINCIPAL_HEADER]: userId, ...(body === undefined ? {} : { "content-type": "application/json" }), "x-trace-id": `mobile-${crypto.randomUUID()}` },
      ...(body === undefined ? {} : { body }),
    });
    return new NextResponse(await response.text(), { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch { return NextResponse.json({ code: "API_UNAVAILABLE" }, { status: 503 }); }
}

export function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context, "GET"); }
export function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context, "POST"); }
