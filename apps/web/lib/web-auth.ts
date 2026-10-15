import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextRequest, NextResponse } from "next/server";
import { mobileSessionCustomer, rotateMobileSession } from "./mobile-auth";

export const WEB_ACCESS_COOKIE = "parlance_web_access";
export const WEB_REFRESH_COOKIE = "parlance_web_refresh";
export const WEB_LOGIN_COOKIE = "parlance_web_login";

const defaultPublicOrigin = "https://tokenburnerstescent-production.up.railway.app";
const productionCookie = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };

export function webAuthConfiguration() {
  const issuer = process.env.PARLANCE_MOBILE_OIDC_ISSUER?.trim();
  const audience = process.env.PARLANCE_MOBILE_OIDC_AUDIENCE?.trim();
  const clientId = process.env.PARLANCE_WEB_OIDC_CLIENT_ID?.trim() || process.env.PARLANCE_MOBILE_OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.PARLANCE_WEB_OIDC_CLIENT_SECRET?.trim();
  const origin = process.env.PARLANCE_WEB_PUBLIC_ORIGIN?.trim() || defaultPublicOrigin;
  const jwks = process.env.PARLANCE_MOBILE_OIDC_JWKS_URI?.trim();
  try {
    const issuerUrl = new URL(issuer ?? "");
    const originUrl = new URL(origin);
    const jwksUrl = new URL(jwks ?? "");
    if (issuerUrl.protocol !== "https:" || originUrl.protocol !== "https:" || jwksUrl.protocol !== "https:" ||
        jwksUrl.origin !== issuerUrl.origin || !audience || !clientId || issuerUrl.username || issuerUrl.password ||
        originUrl.pathname !== "/" || originUrl.search || originUrl.hash) return;
    return { issuer: issuer!, audience, clientId, clientSecret, origin: originUrl.origin, jwks: jwksUrl };
  } catch { return; }
}

export function webAuthEnabled() {
  return process.env.PARLANCE_PUBLIC_WEB_ENABLED === "true" && Boolean(webAuthConfiguration());
}

export function randomUrlToken() { return randomBytes(32).toString("base64url"); }
export function codeChallenge(verifier: string) { return createHash("sha256").update(verifier).digest("base64url"); }

export async function oidcDiscovery(config: NonNullable<ReturnType<typeof webAuthConfiguration>>) {
  const response = await fetch(new URL(".well-known/openid-configuration", config.issuer.endsWith("/") ? config.issuer : `${config.issuer}/`), { cache: "no-store" });
  if (!response.ok) throw new Error("OIDC_DISCOVERY_UNAVAILABLE");
  const value = await response.json() as Record<string, unknown>;
  const authorization = new URL(String(value.authorization_endpoint ?? ""));
  const token = new URL(String(value.token_endpoint ?? ""));
  if (value.issuer !== config.issuer || value.jwks_uri !== config.jwks.href || authorization.protocol !== "https:" || token.protocol !== "https:" ||
      authorization.origin !== new URL(config.issuer).origin || token.origin !== new URL(config.issuer).origin) throw new Error("OIDC_DISCOVERY_MISMATCH");
  return { authorization, token };
}

export async function verifyIdentityToken(token: string, config: NonNullable<ReturnType<typeof webAuthConfiguration>>, nonce: string) {
  const { payload } = await jwtVerify(token, createRemoteJWKSet(config.jwks), {
    issuer: config.issuer, audience: config.clientId, algorithms: ["RS256", "ES256", "EdDSA"],
  });
  return typeof payload.sub === "string" && payload.sub.length > 0 && payload.nonce === nonce ? payload.sub : undefined;
}

export function setWebSessionCookies(response: NextResponse, session: { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string }) {
  response.cookies.set(WEB_ACCESS_COOKIE, session.accessToken, { ...productionCookie, expires: new Date(session.accessExpiresAt) });
  response.cookies.set(WEB_REFRESH_COOKIE, session.refreshToken, { ...productionCookie, expires: new Date(session.refreshExpiresAt) });
}

export function clearWebSessionCookies(response: NextResponse) {
  for (const name of [WEB_ACCESS_COOKIE, WEB_REFRESH_COOKIE, WEB_LOGIN_COOKIE]) response.cookies.set(name, "", { ...productionCookie, maxAge: 0 });
}

export async function webCustomer(request: NextRequest) {
  const access = request.cookies.get(WEB_ACCESS_COOKIE)?.value;
  if (access) {
    const userId = await mobileSessionCustomer(`Bearer ${access}`);
    if (userId) return { userId };
  }
  const refresh = request.cookies.get(WEB_REFRESH_COOKIE)?.value;
  if (!refresh) return;
  const rotated = await rotateMobileSession(refresh);
  if (!rotated) return;
  const userId = await mobileSessionCustomer(`Bearer ${rotated.accessToken}`);
  return userId ? { userId, rotated } : undefined;
}

export function sameOrigin(request: NextRequest) {
  const config = webAuthConfiguration();
  return Boolean(config && request.headers.get("origin") === config.origin);
}
