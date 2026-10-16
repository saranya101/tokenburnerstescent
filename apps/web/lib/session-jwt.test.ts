import { afterEach, beforeEach, expect, it } from "vitest";
import { SignJWT } from "jose";
import { passwordAuthReady, sessionJwtKey, signSessionJwt, verifySessionJwt } from "./session-jwt";
beforeEach(() => { process.env.PARLANCE_AUTH_JWT_SECRET = "a-test-signing-secret-with-at-least-32-bytes"; });
afterEach(() => { delete process.env.PARLANCE_AUTH_JWT_SECRET; });
it("uses signed, expiring, audience-bound JWTs with unique session IDs", async () => {
  const first = await signSessionJwt("customer-one", new Date(Date.now() + 60000));
  const second = await signSessionJwt("customer-one", new Date(Date.now() + 60000));
  expect(first.split(".")).toHaveLength(3);
  expect(first).not.toBe(second);
  expect(await verifySessionJwt(first)).toBe("customer-one");
  expect(await verifySessionJwt(first.slice(0, -8) + "tampered")).toBeUndefined();
  expect(await verifySessionJwt(await signSessionJwt("customer-one", new Date(0)))).toBeUndefined();
});
it("rejects an otherwise signed token for another audience", async () => {
  const token = await new SignJWT({ purpose: "customer-access" }).setProtectedHeader({ alg: "HS256" }).setSubject("other").setIssuer("parlance").setAudience("admin").setIssuedAt().setJti("test").setExpirationTime("5m").sign(sessionJwtKey());
  expect(await verifySessionJwt(token)).toBeUndefined();
});
it("fails closed when signing configuration is absent or too short", () => {
  process.env.PARLANCE_AUTH_JWT_SECRET = "short"; expect(passwordAuthReady()).toBe(false);
  delete process.env.PARLANCE_AUTH_JWT_SECRET; expect(passwordAuthReady()).toBe(false);
});
