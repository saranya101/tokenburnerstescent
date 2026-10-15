import { NextRequest, NextResponse } from "next/server";
import { createMobileSession, verifiedOidcIdentity } from "../../../../lib/mobile-auth";
import { oidcDiscovery, setWebSessionCookies, verifyIdentityToken, WEB_LOGIN_COOKIE, webAuthConfiguration, webAuthEnabled } from "../../../../lib/web-auth";

export async function GET(request: NextRequest) {
  const config = webAuthConfiguration();
  if (!config || !webAuthEnabled()) return new NextResponse(null, { status: 503 });
  const fail = () => NextResponse.redirect(`${config.origin}/?signin=failed`);
  const stateCookie = request.cookies.get(WEB_LOGIN_COOKIE)?.value;
  if (!stateCookie || request.nextUrl.searchParams.has("error")) return fail();
  try {
    const state = JSON.parse(Buffer.from(stateCookie, "base64url").toString("utf8")) as Record<string, unknown>;
    const code = request.nextUrl.searchParams.get("code");
    if (typeof state.state !== "string" || state.state !== request.nextUrl.searchParams.get("state") ||
        typeof state.verifier !== "string" || typeof state.nonce !== "string" || !code || code.length > 4096) return fail();
    const endpoints = await oidcDiscovery(config);
    const response = await fetch(endpoints.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, code,
        code_verifier: state.verifier, redirect_uri: `${config.origin}/api/web-auth/callback`,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) }), cache: "no-store" });
    if (!response.ok) return fail();
    const tokens = await response.json() as Record<string, unknown>;
    if (typeof tokens.id_token !== "string" || typeof tokens.access_token !== "string") return fail();
    const idSubject = await verifyIdentityToken(tokens.id_token, config, state.nonce);
    const identity = await verifiedOidcIdentity(`Bearer ${tokens.access_token}`, config.clientId);
    if (!idSubject || !identity || identity.subject !== idSubject) return fail();
    const session = await createMobileSession(identity);
    const redirect = NextResponse.redirect(config.origin);
    redirect.headers.set("cache-control", "no-store");
    redirect.cookies.set(WEB_LOGIN_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/api/web-auth", maxAge: 0 });
    setWebSessionCookies(redirect, session);
    return redirect;
  } catch { return fail(); }
}
