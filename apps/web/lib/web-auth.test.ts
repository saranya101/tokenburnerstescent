import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const session = vi.hoisted(() => ({ userId: undefined as string | undefined, rotated: undefined as undefined | { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string } }));
vi.mock("./mobile-auth", () => ({
  mobileSessionCustomer: async (authorization: string) => authorization === "Bearer valid-access" || authorization === "Bearer next-access" ? session.userId : undefined,
  rotateMobileSession: async (refresh: string) => refresh === "valid-refresh" ? session.rotated : undefined,
}));
import { codeChallenge, sameOrigin, webAuthConfiguration, webCustomer } from "./web-auth";

beforeEach(() => {
  process.env.PARLANCE_MOBILE_OIDC_ISSUER = "https://tenant.example/";
  process.env.PARLANCE_MOBILE_OIDC_AUDIENCE = "https://api.example";
  process.env.PARLANCE_MOBILE_OIDC_CLIENT_ID = "native-client";
  process.env.PARLANCE_MOBILE_OIDC_JWKS_URI = "https://tenant.example/.well-known/jwks.json";
  session.userId = undefined; session.rotated = undefined;
});
afterEach(() => {
  for (const key of ["PARLANCE_MOBILE_OIDC_ISSUER", "PARLANCE_MOBILE_OIDC_AUDIENCE", "PARLANCE_MOBILE_OIDC_CLIENT_ID", "PARLANCE_MOBILE_OIDC_JWKS_URI", "PARLANCE_WEB_OIDC_CLIENT_ID"]) delete process.env[key];
});

it("requires coherent HTTPS provider settings and supports a separate public web client", () => {
  expect(webAuthConfiguration()?.clientId).toBe("native-client");
  process.env.PARLANCE_WEB_OIDC_CLIENT_ID = "web-client";
  expect(webAuthConfiguration()?.clientId).toBe("web-client");
  process.env.PARLANCE_MOBILE_OIDC_JWKS_URI = "https://attacker.example/keys";
  expect(webAuthConfiguration()).toBeUndefined();
});

it("uses PKCE S256 and rejects cross-origin writes", () => {
  expect(codeChallenge("known-verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(sameOrigin(new NextRequest("https://bank.example/api/parlance/messages", { headers: { origin: "https://evil.example" } }))).toBe(false);
  expect(sameOrigin(new NextRequest("https://bank.example/api/parlance/messages", { headers: { origin: "https://tokenburnerstescent-production.up.railway.app" } }))).toBe(true);
});

it("resolves only a validated mapped customer and rotates expiring sessions", async () => {
  const anonymous = new NextRequest("https://bank.example/api/web-auth/session");
  expect(await webCustomer(anonymous)).toBeUndefined();
  session.userId = "customer-a";
  const active = new NextRequest("https://bank.example/api/web-auth/session", { headers: { cookie: "parlance_web_access=valid-access" } });
  expect((await webCustomer(active))?.userId).toBe("customer-a");
  session.rotated = { accessToken: "next-access", refreshToken: "next-refresh", accessExpiresAt: new Date(Date.now() + 60000).toISOString(), refreshExpiresAt: new Date(Date.now() + 600000).toISOString() };
  const expired = new NextRequest("https://bank.example/api/web-auth/session", { headers: { cookie: "parlance_web_access=expired; parlance_web_refresh=valid-refresh" } });
  expect((await webCustomer(expired))?.rotated?.accessToken).toBe("next-access");
});
