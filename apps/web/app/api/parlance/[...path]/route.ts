import { NextRequest, NextResponse } from "next/server";

const apiBaseUrl = (): string => (process.env.API_URL?.trim() || "http://127.0.0.1:4001").replace(/\/$/u, "");

const postRoutes = [
  /^messages$/u,
  /^webauthn\/registration\/(?:options|verify)$/u,
  /^goal-candidates\/[^/]+\/confirm$/u,
  /^goals\/[^/]+\/compile$/u,
  /^plans\/[^/]+\/approval-options$/u,
  /^plans\/[^/]+\/approval-verify$/u,
  /^executions\/[^/]+\/run$/u,
];
const getRoutes = [/^executions\/[^/]+\/detail$/u, /^webauthn\/registration\/status$/u];

function customerUserId(): string | undefined {
  const value = process.env.PARLANCE_CUSTOMER_USER_ID?.trim();
  return value ? value : undefined;
}

function allowed(method: "GET" | "POST", path: string): boolean {
  return (method === "POST" ? postRoutes : getRoutes).some((pattern) => pattern.test(path));
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }, method: "GET" | "POST") {
  const path = (await context.params).path.join("/");
  if (!allowed(method, path)) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  let body: string | undefined;
  if (method === "POST") {
    let input: unknown;
    try { input = await request.json(); } catch { input = {}; }
    if (path === "messages") {
      const userId = customerUserId();
      if (!userId) return NextResponse.json({ code: "CUSTOMER_IDENTITY_NOT_CONFIGURED" }, { status: 503 });
      if (!input || typeof input !== "object" || !("text" in input) || typeof input.text !== "string" || input.text.trim().length === 0 || Object.keys(input).some((key) => key !== "text")) {
        return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
      }
      body = JSON.stringify({ userId, text: input.text });
    } else {
      body = JSON.stringify(input);
    }
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/v1/${path}`, {
      method, cache: "no-store",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-trace-id": `web-${crypto.randomUUID()}` },
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    return NextResponse.json({ code: "API_UNAVAILABLE" }, { status: 503 });
  }
  const responseBody = await response.text();
  return new NextResponse(responseBody, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", ...(response.headers.get("x-trace-id") ? { "x-trace-id": response.headers.get("x-trace-id")! } : {}) },
  });
}

export function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context, "POST"); }
export function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context, "GET"); }
