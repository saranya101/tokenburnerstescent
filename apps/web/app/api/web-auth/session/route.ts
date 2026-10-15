import { NextRequest, NextResponse } from "next/server";
import { BankStateSnapshotV1, CustomerActivityV1 } from "@parlance/contracts";
import { apiBaseUrl, CUSTOMER_PRINCIPAL_HEADER, INTERNAL_TOKEN_HEADER, webSecurityConfigurationValid } from "../../../../lib/server-api-auth";
import { setWebSessionCookies, webAuthEnabled, webCustomer } from "../../../../lib/web-auth";

export async function GET(request: NextRequest) {
  if (!webAuthEnabled()) return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 });
  try {
    const customer = await webCustomer(request);
    if (!customer) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: { "cache-control": "no-store" } });
    const unavailable = () => {
      const response = NextResponse.json({ code: "CUSTOMER_STATE_UNAVAILABLE" }, { status: 503, headers: { "cache-control": "no-store" } });
      if (customer.rotated) setWebSessionCookies(response, customer.rotated);
      return response;
    };
    const internalToken = process.env.PARLANCE_INTERNAL_API_TOKEN?.trim();
    if (!internalToken || !webSecurityConfigurationValid()) return unavailable();
    const headers = { [INTERNAL_TOKEN_HEADER]: internalToken, [CUSTOMER_PRINCIPAL_HEADER]: customer.userId };
    const upstream = await fetch(`${apiBaseUrl()}/v1/customer/state`, {
      cache: "no-store", signal: AbortSignal.timeout(3000), headers,
    });
    if (!upstream.ok) return unavailable();
    const snapshot = BankStateSnapshotV1.safeParse(await upstream.json());
    if (!snapshot.success || snapshot.data.userId !== customer.userId) return unavailable();
    const activity = await fetch(`${apiBaseUrl()}/v1/customer/activity`, { cache: "no-store", signal: AbortSignal.timeout(3000), headers });
    if (!activity.ok || !CustomerActivityV1.safeParse(await activity.json()).success) return unavailable();
    const response = NextResponse.json({ authenticated: true, financialExecutionEnabled: false }, { headers: { "cache-control": "no-store" } });
    if (customer.rotated) setWebSessionCookies(response, customer.rotated);
    return response;
  } catch { return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 }); }
}
