import { NextRequest, NextResponse } from "next/server";

const apiBaseUrl = (): string => (process.env.API_URL?.trim() || "http://127.0.0.1:4001").replace(/\/$/u, "");

const postRoutes = [
  /^messages$/u,
  /^clarifications\/[^/]+\/answer$/u,
  /^bundle-clarifications\/[^/]+\/answer$/u,
  /^webauthn\/registration\/(?:options|verify)$/u,
  /^goal-candidates\/[^/]+\/confirm$/u,
  /^goal-bundle-candidates\/[^/]+\/confirm$/u,
  /^goals\/[^/]+\/compile$/u,
  /^goal-bundles\/[^/]+\/compile$/u,
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

function messageBody(input: unknown, userId: string): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const item = input as Record<string, unknown>;
  if (typeof item.text !== "string" || item.text.trim().length === 0) return undefined;
  if (item.inputMode === undefined && Object.keys(item).every((key) => key === "text")) return { userId, text: item.text };
  if (item.inputMode !== "VOICE" || Object.keys(item).some((key) => !["text", "inputMode", "voice"].includes(key))) return undefined;
  if (!item.voice || typeof item.voice !== "object" || Array.isArray(item.voice)) return undefined;
  const voice = item.voice as Record<string, unknown>;
  if (Object.keys(voice).some((key) => !["rawTranscript", "provider", "transcribedAt"].includes(key)) || typeof voice.rawTranscript !== "string" || voice.rawTranscript.length === 0 || typeof voice.provider !== "string" || voice.provider.length === 0 || typeof voice.transcribedAt !== "string" || !Number.isFinite(Date.parse(voice.transcribedAt))) return undefined;
  return { userId, text: item.text, inputMode: "VOICE", voice };
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
      const normalized = messageBody(input, userId);
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
