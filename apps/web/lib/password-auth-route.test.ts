import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const auth = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./password-auth", async (original) => ({ ...await original<typeof import("./password-auth")>(), authenticatePassword: auth.call }));
import { passwordAuthResponse } from "./password-auth-route";
const tokens = { accessToken: "signed.jwt.access", refreshToken: "refresh-secret", accessExpiresAt: "2030-01-01T00:00:00.000Z", refreshExpiresAt: "2030-02-01T00:00:00.000Z" };
beforeEach(() => { process.env.PARLANCE_AUTH_JWT_SECRET = "a-test-signing-secret-with-at-least-32-bytes"; process.env.PARLANCE_WEB_PUBLIC_ORIGIN = "https://bank.example"; auth.call.mockReset().mockResolvedValue(tokens); });
afterEach(() => { delete process.env.PARLANCE_AUTH_JWT_SECRET; delete process.env.PARLANCE_WEB_PUBLIC_ORIGIN; });
function request(origin = "https://bank.example", body = JSON.stringify({ email: "any@gmail.com", password: "valid-password" })) { return new NextRequest("https://bank.example/api/web-auth/login", { method: "POST", headers: { origin }, body }); }
it("keeps browser JWT and refresh credentials only in secure HttpOnly cookies", async () => {
  const response = await passwordAuthResponse(request(), "signup", true);
  expect(response.status).toBe(201); expect(await response.json()).toEqual({ authenticated: true });
  const cookies = response.headers.get("set-cookie")!;
  expect(cookies).toContain("HttpOnly"); expect(cookies).toContain("Secure"); expect(cookies).toContain("SameSite=lax");
});
it("returns session tokens directly to the native client", async () => {
  const response = await passwordAuthResponse(request(), "login", false);
  expect(await response.json()).toEqual(tokens); expect(response.headers.has("set-cookie")).toBe(false);
});
it("rejects cross-origin browser requests before checking credentials", async () => {
  expect((await passwordAuthResponse(request("https://evil.example"), "login", true)).status).toBe(403);
  expect(auth.call).not.toHaveBeenCalled();
});
it("rejects malformed and oversized requests", async () => {
  expect((await passwordAuthResponse(request("https://bank.example", "oops"), "login", true)).status).toBe(400);
  expect((await passwordAuthResponse(request("https://bank.example", "x".repeat(2049)), "signup", true)).status).toBe(413);
});
