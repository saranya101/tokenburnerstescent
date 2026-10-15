import { NextResponse } from "next/server";
import { codeChallenge, oidcDiscovery, randomUrlToken, WEB_LOGIN_COOKIE, webAuthConfiguration, webAuthEnabled } from "../../../../lib/web-auth";

export async function GET() {
  const config = webAuthConfiguration();
  if (!config || !webAuthEnabled()) return new NextResponse(null, { status: 503 });
  try {
    const endpoints = await oidcDiscovery(config);
    const state = randomUrlToken(); const nonce = randomUrlToken(); const verifier = randomUrlToken();
    const callback = `${config.origin}/api/web-auth/callback`;
    const url = new URL(endpoints.authorization);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: config.clientId, redirect_uri: callback,
      scope: "openid profile", audience: config.audience, state, nonce, code_challenge: codeChallenge(verifier), code_challenge_method: "S256" })) url.searchParams.set(key, value);
    const response = NextResponse.redirect(url);
    response.headers.set("cache-control", "no-store");
    response.cookies.set(WEB_LOGIN_COOKIE, Buffer.from(JSON.stringify({ state, nonce, verifier })).toString("base64url"), {
      httpOnly: true, secure: true, sameSite: "lax", path: "/api/web-auth", maxAge: 600,
    });
    return response;
  } catch { return new NextResponse(null, { status: 503 }); }
}
