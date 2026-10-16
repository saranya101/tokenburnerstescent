import { createHash, randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";
import { getPrismaClient } from "@parlance/db";
import { createMobileSession } from "./mobile-auth";

const scrypt = (password: string, salt: string, size: number, options: { N: number; r: number; p: number; maxmem: number }) => new Promise<Buffer>((resolve, reject) => {
  derive(password, salt, size, options, (error, key) => error ? reject(error) : resolve(key));
});
export const PASSWORD_IDENTITY_ISSUER = "parlance:password";
export class AuthenticationError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export function credentials(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthenticationError("INVALID_CREDENTIALS", 400);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "email" && key !== "password") || typeof input.email !== "string" || typeof input.password !== "string") throw new AuthenticationError("INVALID_CREDENTIALS", 400);
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(email) || input.password.length < 10 || input.password.length > 128) throw new AuthenticationError("INVALID_CREDENTIALS", 400);
  return { email, password: input.password };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
  return `scrypt-v1$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/u.exec(encoded);
  if (!match) return false;
  const derived = await scrypt(password, match[1]!, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
  return timingSafeEqual(derived, Buffer.from(match[2]!, "hex"));
}

async function throttle(key: string, maximum: number) {
  const db = getPrismaClient(); const now = new Date();
  const digest = createHash("sha256").update(key).digest("hex");
  // Atomic increment across every server instance; an expired window is reset before use.
  await db.authThrottle.deleteMany({ where: { key: digest, expiresAt: { lte: now } } });
  const row = await db.authThrottle.upsert({ where: { key: digest }, create: { key: digest, attempts: 1, expiresAt: new Date(now.getTime() + 15 * 60 * 1000) }, update: { attempts: { increment: 1 } } });
  if (row.attempts > maximum) throw new AuthenticationError("TOO_MANY_ATTEMPTS", 429);
}

export async function authenticatePassword(mode: "login" | "signup", value: unknown, network: string) {
  const input = credentials(value);
  await throttle(`network:${network}`, 60);
  await throttle(`email:${input.email}`, 12);
  const db = getPrismaClient();
  let userId: string;
  if (mode === "signup") {
    const passwordHash = await hashPassword(input.password);
    try {
      const user = await db.$transaction(async (tx) => {
        const created = await tx.user.create({ data: {
        passwordCredential: { create: { email: input.email, passwordHash } },
        riskProfile: { create: { kycStatus: "REVIEW_REQUIRED" } },
        } });
        await tx.externalIdentity.create({ data: { issuer: PASSWORD_IDENTITY_ISSUER, subject: created.id, userId: created.id } });
        return created;
      });
      userId = user.id;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") throw new AuthenticationError("ACCOUNT_UNAVAILABLE", 409);
      throw error;
    }
  } else {
    const saved = await db.passwordCredential.findUnique({ where: { email: input.email } });
    // Equivalent scrypt work for unknown emails prevents a fast account-existence oracle.
    const encoded = saved?.passwordHash ?? `scrypt-v1$${"0".repeat(32)}$${"0".repeat(128)}`;
    const valid = await verifyPassword(input.password, encoded);
    if (!saved || !valid) throw new AuthenticationError("LOGIN_FAILED", 401);
    userId = saved.userId;
  }
  return createMobileSession({ userId, issuer: PASSWORD_IDENTITY_ISSUER, subject: userId });
}
