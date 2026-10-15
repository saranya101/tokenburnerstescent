import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ idSubject: "auth0|test-user", mappedSubject: "auth0|test-user", created: 0 }));
vi.mock("../../../../lib/web-auth", () => ({
  webAuthEnabled: () => true,
  webAuthConfiguration: () => ({ origin: "https://bank.example", clientId: "web-client" }),
  oidcDiscovery: async () => ({ token: new URL("https://identity.example/oauth/token") }),
  verifyIdentityToken: async () => auth.idSubject,
  setWebSessionCookies: vi.fn(),
  WEB_LOGIN_COOKIE: "parlance_web_login",
}));
vi.mock("../../../../lib/mobile-auth", () => ({
  verifiedOidcIdentity: async () => ({ issuer: "https://identity.example/", subject: auth.mappedSubject, userId: "synthetic-customer" }),
  createMobileSession: async () => { auth.created++; return { accessToken: "test-access", refreshToken: "test-refresh", accessExpiresAt: "2030-01-01T00:00:00.000Z", refreshExpiresAt: "2030-02-01T00:00:00.000Z" }; },
}));
import { GET } from "./route";

function callback(state = "expected") {
  const cookie = Buffer.from(JSON.stringify({ state: "expected", nonce: "nonce", verifier: "verifier" })).toString("base64url");
  return new NextRequest(`https://bank.example/api/web-auth/callback?code=authorization-code&state=${state}`, { headers: { cookie: `parlance_web_login=${cookie}` } });
}
beforeEach(() => { auth.idSubject = "auth0|test-user"; auth.mappedSubject = "auth0|test-user"; auth.created = 0; });
afterEach(() => vi.unstubAllGlobals());

it("rejects a mismatched OAuth state before token exchange", async () => {
  const tokenExchange = vi.fn(); vi.stubGlobal("fetch", tokenExchange);
  const response = await GET(callback("wrong"));
  expect(response.headers.get("location")).toBe("https://bank.example/?signin=failed");
  expect(tokenExchange).not.toHaveBeenCalled();
  expect(auth.created).toBe(0);
});

it("establishes a customer session only when signed ID and access token subjects match", async () => {
  const tokenExchange = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id_token: "signed-id", access_token: "signed-access" }), { status: 200 }));
  vi.stubGlobal("fetch", tokenExchange);
  const response = await GET(callback());
  expect(response.headers.get("location")).toBe("https://bank.example/");
  expect(auth.created).toBe(1);
  expect(tokenExchange).toHaveBeenCalledWith(new URL("https://identity.example/oauth/token"), expect.objectContaining({ method: "POST" }));
  const form = tokenExchange.mock.calls[0]![1].body as URLSearchParams;
  expect(form.get("code_verifier")).toBe("verifier");
  expect(form.get("redirect_uri")).toBe("https://bank.example/api/web-auth/callback");
});

it("rejects a cross-identity token pair without creating a customer session", async () => {
  auth.mappedSubject = "auth0|other-user";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id_token: "signed-id", access_token: "signed-access" }), { status: 200 })));
  const response = await GET(callback());
  expect(response.headers.get("location")).toBe("https://bank.example/?signin=failed");
  expect(auth.created).toBe(0);
});
