import { NextRequest, NextResponse } from "next/server";

// A public interface preview remains closed until customer authentication and
// the shared backend have been provisioned and verified.
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (process.env.PARLANCE_PUBLIC_SAFE_MODE === "true" &&
      (path === "/execution" || path.startsWith("/execution/") || path === "/demo" || path.startsWith("/demo/"))) {
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const publicApiOrOps = path === "/api" || path.startsWith("/api/") || path === "/ops" || path.startsWith("/ops/");
  const mobileGatewayReady = process.env.PARLANCE_PUBLIC_MOBILE_ENABLED === "true" && [
    "PARLANCE_AUTH_JWT_SECRET",
    "DATABASE_URL", "DIRECT_URL", "PARLANCE_INTERNAL_API_TOKEN", "API_URL",
  ].every((key) => Boolean(process.env[key]?.trim()));
  const allowedMobileRoute = path.startsWith("/api/mobile/") && mobileGatewayReady;
  const allowedWebRoute = process.env.PARLANCE_PUBLIC_WEB_ENABLED === "true" && mobileGatewayReady &&
    (path.startsWith("/api/web-auth/") || path.startsWith("/api/parlance/"));
  if (process.env.PARLANCE_PUBLIC_SAFE_MODE === "true" && publicApiOrOps && !allowedMobileRoute && !allowedWebRoute) {
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (process.env.PARLANCE_MOBILE_GATEWAY_ONLY === "true" && !path.startsWith("/api/mobile/")) {
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
