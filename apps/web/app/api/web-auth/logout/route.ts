import { NextRequest, NextResponse } from "next/server";
import { revokeAccessSession, revokeMobileSession } from "../../../../lib/mobile-auth";
import { clearWebSessionCookies, sameOrigin, WEB_ACCESS_COOKIE, WEB_REFRESH_COOKIE } from "../../../../lib/web-auth";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ code: "FORBIDDEN" }, { status: 403 });
  const refresh = request.cookies.get(WEB_REFRESH_COOKIE)?.value;
  const access = request.cookies.get(WEB_ACCESS_COOKIE)?.value;
  try {
    if (refresh) await revokeMobileSession(refresh);
    if (access) await revokeAccessSession(access);
  }
  catch { return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 }); }
  const response = new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  clearWebSessionCookies(response);
  return response;
}
