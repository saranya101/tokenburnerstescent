import { beforeEach, describe, expect, it, vi } from "vitest";

type SessionRow = { id: string; accessHash: string; refreshHash: string; accessExpiresAt: Date; refreshExpiresAt: Date; revokedAt: Date | null };
const memory = vi.hoisted(() => {
  const sessions = new Map<string, SessionRow>();
  const identities = new Map<string, string>();
  return { sessions, identities };
});
vi.mock("@parlance/db", () => ({ getPrismaClient: () => ({
  externalIdentity: { findUnique: async ({ where }: { where: { issuer_subject: { issuer: string; subject: string } } }) => { const key = `${where.issuer_subject.issuer}\0${where.issuer_subject.subject}`; const userId = memory.identities.get(key); return userId ? { userId } : null; } },
  mobileSession: {
    create: async ({ data }: { data: Omit<SessionRow, "id" | "revokedAt"> }) => { memory.sessions.set("session-1", { ...data, id: "session-1", revokedAt: null }); },
    findUnique: async ({ where }: { where: { accessHash?: string; refreshHash?: string } }) => [...memory.sessions.values()].find((row) => row.accessHash === where.accessHash || row.refreshHash === where.refreshHash) ?? null,
    updateMany: async ({ where, data }: { where: { id?: string; refreshHash?: string; refreshExpiresAt?: { gt: Date } }; data: Partial<SessionRow> }) => {
      const row = [...memory.sessions.values()].find((item) => (where.id ? item.id === where.id : item.refreshHash === where.refreshHash));
      if (!row || row.revokedAt || (where.refreshHash && row.refreshHash !== where.refreshHash) || (where.refreshExpiresAt && row.refreshExpiresAt <= where.refreshExpiresAt.gt)) return { count: 0 };
      Object.assign(row, data); return { count: 1 };
    },
  },
}) }));

import { createMobileSession, mobileSessionCustomer, revokeMobileSession, rotateMobileSession } from "./mobile-auth";

const identity = { userId: "customer-a", issuer: "https://identity.example", subject: "subject-a" };
beforeEach(() => { memory.sessions.clear(); memory.identities.clear(); memory.identities.set(`${identity.issuer}\0${identity.subject}`, identity.userId); });

describe("mobile sessions", () => {
  it("stores only token hashes and resolves the mapped customer", async () => {
    const tokens = await createMobileSession(identity);
    const row = memory.sessions.get("session-1")!;
    expect(row.accessHash).not.toContain(tokens.accessToken);
    expect(row.refreshHash).not.toContain(tokens.refreshToken);
    expect(await mobileSessionCustomer(`Bearer ${tokens.accessToken}`)).toBe("customer-a");
    expect(await mobileSessionCustomer("Bearer caller-supplied-id")).toBeUndefined();
    memory.identities.delete(`${identity.issuer}\0${identity.subject}`);
    expect(await mobileSessionCustomer(`Bearer ${tokens.accessToken}`)).toBeUndefined();
  });
  it("rotates refresh credentials once and invalidates the prior access token", async () => {
    const first = await createMobileSession(identity);
    const next = await rotateMobileSession(first.refreshToken);
    expect(next?.accessToken).not.toBe(first.accessToken);
    expect(next?.refreshExpiresAt).toBe(first.refreshExpiresAt);
    expect(await rotateMobileSession(first.refreshToken)).toBeUndefined();
    expect(await mobileSessionCustomer(`Bearer ${first.accessToken}`)).toBeUndefined();
    expect(await mobileSessionCustomer(`Bearer ${next!.accessToken}`)).toBe("customer-a");
  });
  it("rejects expired access and refresh tokens, then revokes sign-out credentials", async () => {
    const tokens = await createMobileSession(identity); const row = memory.sessions.get("session-1")!;
    row.accessExpiresAt = new Date(0);
    expect(await mobileSessionCustomer(`Bearer ${tokens.accessToken}`)).toBeUndefined();
    row.accessExpiresAt = new Date(Date.now() + 60000);
    await revokeMobileSession(tokens.refreshToken);
    expect(await mobileSessionCustomer(`Bearer ${tokens.accessToken}`)).toBeUndefined();
    expect(await rotateMobileSession(tokens.refreshToken)).toBeUndefined();
  });
});
