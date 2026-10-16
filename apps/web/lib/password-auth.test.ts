import { beforeEach, expect, it, vi } from "vitest";
const memory = vi.hoisted(() => ({ users: new Map<string, { userId: string; passwordHash: string }>(), identities: [] as unknown[], counts: new Map<string, number>() }));
vi.mock("./mobile-auth", () => ({ createMobileSession: vi.fn(async (identity) => ({ accessToken: `token-${identity.userId}` })) }));
vi.mock("@parlance/db", () => {
  const db = {
    authThrottle: { deleteMany: async () => {}, upsert: async ({ where }: { where: { key: string } }) => { const attempts = (memory.counts.get(where.key) ?? 0) + 1; memory.counts.set(where.key, attempts); return { attempts }; } },
    passwordCredential: { findUnique: async ({ where }: { where: { email: string } }) => memory.users.get(where.email) },
    user: { create: async ({ data }: { data: { passwordCredential: { create: { email: string; passwordHash: string } }; riskProfile: { create: { kycStatus: string } } } }) => {
      const input = data.passwordCredential.create;
      if (memory.users.has(input.email)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
      const userId = `new-customer-${memory.users.size + 1}`;
      memory.users.set(input.email, { userId, passwordHash: input.passwordHash });
      expect(data.riskProfile.create.kycStatus).toBe("REVIEW_REQUIRED");
      return { id: userId };
    } },
    externalIdentity: { create: async ({ data }: { data: unknown }) => { memory.identities.push(data); } },
    $transaction: async (work: (client: unknown) => Promise<unknown>): Promise<unknown> => work(db),
  };
  return { getPrismaClient: () => db };
});
import { authenticatePassword, credentials, hashPassword, verifyPassword } from "./password-auth";
beforeEach(() => { memory.users.clear(); memory.identities.length = 0; memory.counts.clear(); });
it("normalizes arbitrary Gmail and other email addresses without verification or caller IDs", () => {
  expect(credentials({ email: " Someone@Gmail.com ", password: "valid-password" }).email).toBe("someone@gmail.com");
  expect(credentials({ email: "person@example.org", password: "valid-password" }).email).toBe("person@example.org");
  expect(() => credentials({ email: "person@example.org", password: "valid-password", userId: "victim" })).toThrow();
  expect(() => credentials({ email: "not-email", password: "valid-password" })).toThrow();
  expect(() => credentials({ email: "person@example.org", password: "short" })).toThrow();
});
it("salts password hashes and checks passwords without storing plaintext", async () => {
  const first = await hashPassword("valid-password"); const second = await hashPassword("valid-password");
  expect(first).not.toBe(second); expect(first).not.toContain("valid-password");
  expect(await verifyPassword("valid-password", first)).toBe(true);
  expect(await verifyPassword("wrong-password", first)).toBe(false);
});
it("creates independent customers and logs them in with the same credentials on either client", async () => {
  expect(await authenticatePassword("signup", { email: "First@gmail.com", password: "valid-password" }, "network")).toMatchObject({ accessToken: "token-new-customer-1" });
  expect(await authenticatePassword("signup", { email: "second@example.org", password: "valid-password" }, "network")).toMatchObject({ accessToken: "token-new-customer-2" });
  expect(await authenticatePassword("login", { email: "FIRST@gmail.com", password: "valid-password" }, "network")).toMatchObject({ accessToken: "token-new-customer-1" });
  expect(memory.identities).toEqual([{ issuer: "parlance:password", subject: "new-customer-1", userId: "new-customer-1" }, { issuer: "parlance:password", subject: "new-customer-2", userId: "new-customer-2" }]);
});
it("rejects duplicate registration and wrong or unknown passwords", async () => {
  await authenticatePassword("signup", { email: "one@gmail.com", password: "valid-password" }, "network");
  await expect(authenticatePassword("signup", { email: "ONE@gmail.com", password: "valid-password" }, "network")).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
  for (const email of ["one@gmail.com", "unknown@gmail.com"]) await expect(authenticatePassword("login", { email, password: "wrong-password" }, "network")).rejects.toMatchObject({ code: "LOGIN_FAILED", status: 401 });
});
it("rate limits repeated credential attempts durably", async () => {
  for (let index = 0; index < 12; index++) await expect(authenticatePassword("login", { email: "unknown@gmail.com", password: "wrong-password" }, "network")).rejects.toMatchObject({ status: 401 });
  await expect(authenticatePassword("login", { email: "unknown@gmail.com", password: "wrong-password" }, "network")).rejects.toMatchObject({ code: "TOO_MANY_ATTEMPTS", status: 429 });
});
