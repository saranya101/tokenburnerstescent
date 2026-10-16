import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const session = vi.hoisted(() => ({ userId: undefined as string | undefined, rotated: undefined as undefined | { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string } }));
vi.mock("./mobile-auth", () => ({
  mobileSessionCustomer: async (authorization: string) => authorization === "Bearer valid-access" || authorization === "Bearer next-access" ? session.userId : undefined,
  rotateMobileSession: async (refresh: string) => refresh === "valid-refresh" ? session.rotated : undefined,
}));
import { sameOrigin, webAuthEnabled, webCustomer } from "./web-auth";

beforeEach(() => {
  process.env.PARLANCE_AUTH_JWT_SECRET = "test-signing-secret-with-at-least-32-bytes";
  process.env.PARLANCE_PUBLIC_WEB_ENABLED = "true";
  session.userId = undefined; session.rotated = undefined;
});
afterEach(() => { delete process.env.PARLANCE_AUTH_JWT_SECRET; delete process.env.PARLANCE_PUBLIC_WEB_ENABLED; });
it("requires a configured signing secret and no identity provider", () => {
  expect(webAuthEnabled()).toBe(true);
  delete process.env.PARLANCE_AUTH_JWT_SECRET; expect(webAuthEnabled()).toBe(false);
});
it("rejects cross-origin browser writes", () => {
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
