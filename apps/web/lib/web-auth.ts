import { NextRequest, NextResponse } from "next/server";
import { mobileSessionCustomer, rotateMobileSession } from "./mobile-auth";
import { passwordAuthReady } from "./session-jwt";

export const WEB_ACCESS_COOKIE = "parlance_web_access";
export const WEB_REFRESH_COOKIE = "parlance_web_refresh";
export const WEB_LOGIN_COOKIE = "parlance_web_login";

const defaultPublicOrigin = "https://tokenburnerstescent-production.up.railway.app";
const productionCookie = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };

export function webAuthEnabled() {
  return process.env.PARLANCE_PUBLIC_WEB_ENABLED === "true" && passwordAuthReady();
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
  const origin = process.env.PARLANCE_WEB_PUBLIC_ORIGIN?.trim() || defaultPublicOrigin;
  return request.headers.get("origin") === origin;
}
