import { NextRequest, NextResponse } from "next/server";
import { authenticatePassword, AuthenticationError } from "./password-auth";
import { passwordAuthReady } from "./session-jwt";
import { sameOrigin, setWebSessionCookies } from "./web-auth";

export async function passwordAuthResponse(request: NextRequest, mode: "login" | "signup", web: boolean) {
  const headers = { "cache-control": "no-store" };
  if (!passwordAuthReady()) return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503, headers });
  if (web && !sameOrigin(request)) return NextResponse.json({ code: "FORBIDDEN" }, { status: 403, headers });
  try {
    const text = await request.text();
    if (text.length > 2048) return NextResponse.json({ code: "REQUEST_TOO_LARGE" }, { status: 413, headers });
    let input: unknown;
    try { input = JSON.parse(text); } catch { return NextResponse.json({ code: "INVALID_CREDENTIALS" }, { status: 400, headers }); }
    const network = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 100) || "unknown";
    const session = await authenticatePassword(mode, input, network);
    // Browser tokens stay in HttpOnly cookies; native tokens are stored in SecureStore.
    const response = NextResponse.json(web ? { authenticated: true } : session, { status: mode === "signup" ? 201 : 200, headers });
    if (web) setWebSessionCookies(response, session);
    return response;
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ code: error.code }, { status: error.status, headers: { ...headers, ...(error.status === 429 ? { "retry-after": "900" } : {}) } });
    return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503, headers });
  }
}
