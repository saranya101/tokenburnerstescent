import { NextRequest, NextResponse } from "next/server";

// A public interface preview remains closed until customer authentication and
// the shared backend have been provisioned and verified.
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const publicApiOrOps = path === "/api" || path.startsWith("/api/") || path === "/ops" || path.startsWith("/ops/");
  const mobileGatewayReady = process.env.PARLANCE_PUBLIC_MOBILE_ENABLED === "true" && [
    "PARLANCE_MOBILE_OIDC_ISSUER", "PARLANCE_MOBILE_OIDC_CLIENT_ID",
    "PARLANCE_MOBILE_OIDC_AUDIENCE", "PARLANCE_MOBILE_OIDC_JWKS_URI",
    "DATABASE_URL", "DIRECT_URL", "PARLANCE_INTERNAL_API_TOKEN", "API_URL",
  ].every((key) => Boolean(process.env[key]?.trim()));
  const allowedMobileRoute = path.startsWith("/api/mobile/") && mobileGatewayReady;
  if (process.env.PARLANCE_PUBLIC_SAFE_MODE === "true" && publicApiOrOps && !allowedMobileRoute) {
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (process.env.PARLANCE_MOBILE_GATEWAY_ONLY === "true" && !path.startsWith("/api/mobile/")) {
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
