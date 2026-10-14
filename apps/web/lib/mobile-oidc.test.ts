import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const fixture = vi.hoisted(() => ({ publicKey: undefined as (Awaited<ReturnType<typeof exportJWK>> & { kid: string; alg: string; use: string }) | undefined, mappedSubject: "customer-subject" }));
vi.mock("jose", async (importOriginal) => {
  const jose = await importOriginal<typeof import("jose")>();
  return { ...jose, createRemoteJWKSet: () => jose.createLocalJWKSet({ keys: [fixture.publicKey!] }) };
});
vi.mock("@parlance/db", () => ({ getPrismaClient: () => ({
  externalIdentity: { findUnique: async ({ where }: { where: { issuer_subject: { issuer: string; subject: string } } }) =>
    where.issuer_subject.issuer === "https://identity.example" && where.issuer_subject.subject === fixture.mappedSubject ? { userId: "customer-a" } : null },
}) }));

import { verifiedMobileIdentity } from "./mobile-auth";

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = pair.privateKey;
  fixture.publicKey = { ...await exportJWK(pair.publicKey), kid: "test-key", alg: "ES256", use: "sig" };
});
beforeEach(() => {
  fixture.mappedSubject = "customer-subject";
  process.env.PARLANCE_MOBILE_OIDC_ISSUER = "https://identity.example";
  process.env.PARLANCE_MOBILE_OIDC_AUDIENCE = "parlance-mobile-api";
  process.env.PARLANCE_MOBILE_OIDC_CLIENT_ID = "native-client";
  process.env.PARLANCE_MOBILE_OIDC_JWKS_URI = "https://identity.example/keys";
});

async function token(overrides: { issuer?: string; audience?: string; clientId?: string; subject?: string; expiresIn?: string } = {}) {
  return new SignJWT({ azp: overrides.clientId ?? "native-client" })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? "https://identity.example")
    .setAudience(overrides.audience ?? "parlance-mobile-api")
    .setSubject(overrides.subject ?? "customer-subject")
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "5m")
    .sign(privateKey);
}

describe("external mobile identity verification", () => {
  it("accepts a signed, scoped, mapped access token", async () => {
    await expect(verifiedMobileIdentity(`Bearer ${await token()}`)).resolves.toEqual({ userId: "customer-a", issuer: "https://identity.example", subject: "customer-subject" });
  });
  it.each([
    [{ issuer: "https://other.example" }, "issuer"],
    [{ audience: "another-api" }, "audience"],
    [{ clientId: "other-native-client" }, "client"],
    [{ subject: "unmapped-subject" }, "mapping"],
    [{ expiresIn: "-1s" }, "expiry"],
  ] as const)("rejects a bad claim or identity mapping", async (claims, label) => {
    expect(label).toBeTruthy();
    await expect(verifiedMobileIdentity(`Bearer ${await token(claims)}`)).resolves.toBeUndefined();
  });
  it("requires an HTTPS JWKS URI", async () => {
    process.env.PARLANCE_MOBILE_OIDC_JWKS_URI = "http://identity.example/keys";
    await expect(verifiedMobileIdentity(`Bearer ${await token()}`)).resolves.toBeUndefined();
  });
});
