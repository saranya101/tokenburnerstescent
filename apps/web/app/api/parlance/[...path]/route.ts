import { NextRequest, NextResponse } from "next/server";
import { apiBaseUrl, customerApiHeaders, CUSTOMER_PRINCIPAL_HEADER, INTERNAL_TOKEN_HEADER, webSecurityConfigurationValid } from "../../../../lib/server-api-auth";
import { sameOrigin, setWebSessionCookies, webAuthEnabled, webCustomer } from "../../../../lib/web-auth";
import { publicPasskeyExecutionEnabled } from "../../../../lib/financial-capability";

const postRoutes = [
  /^messages$/u,
  /^clarifications\/[^/]+\/answer$/u,
  /^bundle-clarifications\/[^/]+\/answer$/u,
  /^webauthn\/registration\/(?:options|verify)$/u,
  /^goal-candidates\/[^/]+\/confirm$/u,
  /^goal-bundle-candidates\/[^/]+\/confirm$/u,
  /^goals\/[^/]+\/compile$/u,
  /^goals\/[^/]+\/funding-candidate$/u,
  /^goal-bundles\/[^/]+\/compile$/u,
  /^plans\/[^/]+\/approval-options$/u,
  /^plans\/[^/]+\/approval-verify$/u,
  /^executions\/[^/]+\/run$/u,
];
const getRoutes = [/^customer\/(?:state|activity)$/u, /^executions\/[^/]+\/detail$/u, /^webauthn\/registration\/status$/u];

function allowed(method: "GET" | "POST", path: string): boolean {
  return (method === "POST" ? postRoutes : getRoutes).some((pattern) => pattern.test(path));
}

function messageBody(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const item = input as Record<string, unknown>;
  if (typeof item.text !== "string" || item.text.trim().length === 0) return undefined;
  if (item.inputMode === undefined && Object.keys(item).every((key) => key === "text")) return { text: item.text };
  if (item.inputMode !== "VOICE" || Object.keys(item).some((key) => !["text", "inputMode", "voice"].includes(key))) return undefined;
  if (!item.voice || typeof item.voice !== "object" || Array.isArray(item.voice)) return undefined;
  const voice = item.voice as Record<string, unknown>;
  if (Object.keys(voice).some((key) => !["rawTranscript", "provider", "transcribedAt"].includes(key)) || typeof voice.rawTranscript !== "string" || voice.rawTranscript.length === 0 || typeof voice.provider !== "string" || voice.provider.length === 0 || typeof voice.transcribedAt !== "string" || !Number.isFinite(Date.parse(voice.transcribedAt))) return undefined;
  return { text: item.text, inputMode: "VOICE", voice };
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }, method: "GET" | "POST") {
  const parts = (await context.params).path;
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("%") || part.includes("\\"))) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const path = parts.join("/");
  if (!allowed(method, path)) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const publicSafe = process.env.PARLANCE_PUBLIC_SAFE_MODE === "true";
  const enrollmentEnabled = process.env.PARLANCE_PUBLIC_PASSKEY_ENROLLMENT_ENABLED === "true";
  const enrollmentRoute = method === "GET" ? /^webauthn\/registration\/status$/u.test(path) : /^webauthn\/registration\/(?:options|verify)$/u.test(path);
  const executionEnabled = publicPasskeyExecutionEnabled();
  const executionRoute = method === "POST" && [/^plans\/[^/]+\/approval-options$/u, /^plans\/[^/]+\/approval-verify$/u, /^executions\/[^/]+\/run$/u].some((pattern) => pattern.test(path));
  // A separate gate opens only customer-bound approval and execution after durable bank readiness.
  if (publicSafe && !([/^customer\/(?:state|activity)$/u, /^executions\/[^/]+\/detail$/u].some((pattern) => method === "GET" && pattern.test(path)) ||
      [/^messages$/u, /^clarifications\/[^/]+\/answer$/u, /^bundle-clarifications\/[^/]+\/answer$/u,
        /^goal-candidates\/[^/]+\/confirm$/u, /^goal-bundle-candidates\/[^/]+\/confirm$/u,
        /^goals\/[^/]+\/(?:compile|funding-candidate)$/u, /^goal-bundles\/[^/]+\/compile$/u]
        .some((pattern) => method === "POST" && pattern.test(path)) || enrollmentEnabled && enrollmentRoute || executionEnabled && executionRoute)) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  if (publicSafe && (!webAuthEnabled() || (method === "POST" && !sameOrigin(request)))) return NextResponse.json({ code: "FORBIDDEN" }, { status: 403 });
  let customer: Awaited<ReturnType<typeof webCustomer>>;
  if (publicSafe) {
    try { customer = await webCustomer(request); }
    catch { return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 }); }
    if (!customer) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }
  // Browser headers are untrusted; only a validated session supplies customer identity.
  const trustedHeaders = publicSafe ?
    (customer && process.env.PARLANCE_INTERNAL_API_TOKEN?.trim() && webSecurityConfigurationValid() ?
      { [INTERNAL_TOKEN_HEADER]: process.env.PARLANCE_INTERNAL_API_TOKEN.trim(), [CUSTOMER_PRINCIPAL_HEADER]: customer.userId } : undefined) :
    customerApiHeaders();
  if (!trustedHeaders) return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 });

  let body: string | undefined;
  if (method === "POST") {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 32768) return NextResponse.json({ code: "REQUEST_TOO_LARGE" }, { status: 413 });
    let input: unknown;
    let raw: string;
    try { raw = await request.text(); } catch { return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 }); }
    if (raw.length > 32768) return NextResponse.json({ code: "REQUEST_TOO_LARGE" }, { status: 413 });
    try { input = raw ? JSON.parse(raw) : {}; } catch { return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 }); }
    if (path === "messages") {
      const normalized = messageBody(input);
      if (!normalized) return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
      body = JSON.stringify(normalized);
    } else {
      body = JSON.stringify(input);
    }
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/v1/${path}`, {
      method, cache: "no-store",
      headers: { ...trustedHeaders, ...(body === undefined ? {} : { "content-type": "application/json" }), "x-trace-id": `web-${crypto.randomUUID()}` },
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    return NextResponse.json({ code: "API_UNAVAILABLE" }, { status: 503 });
  }
  const responseBody = await response.text();
  if (response.status === 401 || response.status === 403) return NextResponse.json({ code: "REQUEST_NOT_AUTHORIZED" }, { status: response.status });
  const result = new NextResponse(responseBody, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...(response.headers.get("x-trace-id") ? { "x-trace-id": response.headers.get("x-trace-id")! } : {}) },
  });
  if (customer?.rotated) setWebSessionCookies(result, customer.rotated);
  return result;
}

export function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context, "POST"); }
export function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context, "GET"); }
