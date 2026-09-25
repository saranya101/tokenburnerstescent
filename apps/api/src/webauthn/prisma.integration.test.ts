import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@parlance/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaParlanceRepository } from "../repositories/prisma.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const userId = "it-webauthn-user";

describe.skipIf(!testDatabaseUrl)("WebAuthn PostgreSQL challenge authority", () => {
  let db: PrismaClient;
  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: testDatabaseUrl! });
    await db.webAuthnCredential.deleteMany({ where: { userId } });
    await db.webAuthnChallenge.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.user.create({ data: { id: userId } });
  });
  afterAll(async () => {
    if (!db) return;
    await db.webAuthnCredential.deleteMany({ where: { userId } });
    await db.webAuthnChallenge.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("atomically permits exactly one registration consumer and persists one bound credential", async () => {
    const repository = new PrismaParlanceRepository(db); const now = new Date();
    const challenge = await repository.createWebAuthnChallenge({
      id: randomUUID(), userId, purpose: "REGISTRATION", challenge: randomBytes(32).toString("base64url"),
      userHandle: new Uint8Array(randomBytes(32)), expectedRpId: "localhost", expectedOrigin: "http://localhost:3000",
      expiresAt: new Date(now.getTime() + 180_000),
    });
    const credential = { id: randomUUID(), userId, credentialId: `it-credential-${randomUUID()}`, publicKey: new Uint8Array([1, 2, 3]), userHandle: challenge.userHandle!, signCount: 0, transports: ["internal"], deviceType: "multiDevice", backedUp: true };
    const outcomes = await Promise.all([
      repository.consumeRegistrationChallenge({ challengeId: challenge.id, userId, now, credential }),
      repository.consumeRegistrationChallenge({ challengeId: challenge.id, userId, now, credential: { ...credential, id: randomUUID() } }),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await db.webAuthnCredential.count({ where: { userId } })).toBe(1);
    expect((await repository.getWebAuthnChallenge(challenge.id))?.status).toBe("CONSUMED");
    expect((await repository.getWebAuthnCredential(credential.credentialId))?.userId).toBe(userId);
  });
});
