import { NextRequest, NextResponse } from "next/server";

// A public interface preview remains closed until customer authentication and
// the shared backend have been provisioned and verified.
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (process.env.PARLANCE_PUBLIC_SAFE_MODE === "true" && (path === "/api" || path.startsWith("/api/") || path === "/ops" || path.startsWith("/ops/"))) {
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (process.env.PARLANCE_MOBILE_GATEWAY_ONLY === "true" && !path.startsWith("/api/mobile/")) {
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
