import { createHash, randomBytes } from "node:crypto";
import { getPrismaClient } from "@parlance/db";
import { signSessionJwt, verifySessionJwt } from "./session-jwt";

const ACCESS_LIFETIME_MS = 15 * 60 * 1000;
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function bearer(authorization: string | null): string | undefined {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(authorization ?? "");
  return match?.[1];
}
function hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function freshToken(): string { return randomBytes(32).toString("base64url"); }

export async function createMobileSession(identity: { userId: string; issuer: string; subject: string }) {
  if (identity.issuer !== "parlance:password" || identity.subject !== identity.userId) throw new Error("PASSWORD_IDENTITY_REQUIRED");
  const now = new Date(); const refreshToken = freshToken();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_LIFETIME_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_LIFETIME_MS);
  const accessToken = await signSessionJwt(identity.userId, accessExpiresAt);
  await getPrismaClient().mobileSession.create({ data: {
    userId: identity.userId, issuer: identity.issuer, subject: identity.subject,
    accessHash: hash(accessToken), refreshHash: hash(refreshToken), accessExpiresAt, refreshExpiresAt,
  } });
  return { accessToken, refreshToken, accessExpiresAt: accessExpiresAt.toISOString(), refreshExpiresAt: refreshExpiresAt.toISOString() };
}

export async function mobileSessionCustomer(authorization: string | null): Promise<string | undefined> {
  const token = bearer(authorization); if (!token) return;
  const jwtUserId = await verifySessionJwt(token); if (!jwtUserId) return;
  const db = getPrismaClient();
  const session = await db.mobileSession.findUnique({ where: { accessHash: hash(token) }, select: { userId: true, issuer: true, subject: true, accessExpiresAt: true, revokedAt: true } });
  if (!session || session.issuer !== "parlance:password" || session.userId !== jwtUserId || session.revokedAt || session.accessExpiresAt <= new Date()) return;
  const identity = await db.externalIdentity.findUnique({ where: { issuer_subject: { issuer: session.issuer, subject: session.subject } }, select: { userId: true } });
  return identity?.userId === session.userId ? session.userId : undefined;
}

export async function rotateMobileSession(refreshToken: string): Promise<Awaited<ReturnType<typeof createMobileSession>> | undefined> {
  if (!TOKEN_PATTERN.test(refreshToken)) return;
  const db = getPrismaClient(); const oldHash = hash(refreshToken); const now = new Date();
  const session = await db.mobileSession.findUnique({ where: { refreshHash: oldHash }, select: { id: true, userId: true, issuer: true, subject: true, refreshExpiresAt: true, revokedAt: true } });
  if (!session || session.issuer !== "parlance:password" || session.revokedAt || session.refreshExpiresAt <= now) return;
  const identity = await db.externalIdentity.findUnique({ where: { issuer_subject: { issuer: session.issuer, subject: session.subject } }, select: { userId: true } });
  if (identity?.userId !== session.userId) return;
  const nextRefreshToken = freshToken();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_LIFETIME_MS);
  const refreshExpiresAt = session.refreshExpiresAt;
  const accessToken = await signSessionJwt(session.userId, accessExpiresAt);
  const changed = await db.mobileSession.updateMany({ where: { id: session.id, refreshHash: oldHash, revokedAt: null, refreshExpiresAt: { gt: now } }, data: {
    accessHash: hash(accessToken), refreshHash: hash(nextRefreshToken), accessExpiresAt, refreshExpiresAt, lastUsedAt: now,
  } });
  return changed.count === 1 ? { accessToken, refreshToken: nextRefreshToken, accessExpiresAt: accessExpiresAt.toISOString(), refreshExpiresAt: refreshExpiresAt.toISOString() } : undefined;
}

export async function revokeMobileSession(refreshToken: string): Promise<void> {
  if (!TOKEN_PATTERN.test(refreshToken)) return;
  await getPrismaClient().mobileSession.updateMany({ where: { refreshHash: hash(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeAccessSession(accessToken: string): Promise<void> {
  if (!await verifySessionJwt(accessToken)) return;
  await getPrismaClient().mobileSession.updateMany({ where: { accessHash: hash(accessToken), revokedAt: null }, data: { revokedAt: new Date() } });
}
