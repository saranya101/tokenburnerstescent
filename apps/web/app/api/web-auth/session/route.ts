import { NextRequest, NextResponse } from "next/server";
import { setWebSessionCookies, webAuthEnabled, webCustomer } from "../../../../lib/web-auth";

export async function GET(request: NextRequest) {
  if (!webAuthEnabled()) return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 });
  try {
    const customer = await webCustomer(request);
    if (!customer) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: { "cache-control": "no-store" } });
    const response = NextResponse.json({ authenticated: true, financialExecutionEnabled: false }, { headers: { "cache-control": "no-store" } });
    if (customer.rotated) setWebSessionCookies(response, customer.rotated);
    return response;
  } catch { return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 }); }
}
