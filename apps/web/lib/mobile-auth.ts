import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getPrismaClient } from "@parlance/db";

const ACCESS_LIFETIME_MS = 15 * 60 * 1000;
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
let cachedKeys: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedUri: string | undefined;

function bearer(authorization: string | null): string | undefined {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(authorization ?? "");
  return match?.[1];
}
function hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function freshToken(): string { return randomBytes(32).toString("base64url"); }

export async function verifiedOidcIdentity(authorization: string | null, expectedClientId?: string): Promise<{ userId: string; issuer: string; subject: string } | undefined> {
  const issuer = process.env.PARLANCE_MOBILE_OIDC_ISSUER?.trim();
  const audience = process.env.PARLANCE_MOBILE_OIDC_AUDIENCE?.trim();
  const clientId = expectedClientId ?? process.env.PARLANCE_MOBILE_OIDC_CLIENT_ID?.trim();
  const jwksUri = process.env.PARLANCE_MOBILE_OIDC_JWKS_URI?.trim();
  const token = bearer(authorization);
  if (!issuer || !audience || !clientId || !jwksUri || !token) return;
  let url: URL;
  try { url = new URL(jwksUri); } catch { return; }
  if (url.protocol !== "https:" || !issuer.startsWith("https://")) return;
  if (!cachedKeys || cachedUri !== jwksUri) { cachedKeys = createRemoteJWKSet(url); cachedUri = jwksUri; }
  try {
    const { payload } = await jwtVerify(token, cachedKeys, { issuer, audience, algorithms: ["RS256", "ES256", "EdDSA"] });
    if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) return;
    const authorizedClient = payload.azp ?? payload.client_id ?? payload.cid;
    if (authorizedClient !== clientId) return;
    const identity = await getPrismaClient().externalIdentity.findUnique({ where: { issuer_subject: { issuer, subject: payload.sub } }, select: { userId: true } });
    return identity ? { userId: identity.userId, issuer, subject: payload.sub } : undefined;
  } catch { return; }
}

export function verifiedMobileIdentity(authorization: string | null) {
  return verifiedOidcIdentity(authorization);
}

export async function createMobileSession(identity: { userId: string; issuer: string; subject: string }) {
  const now = new Date(); const accessToken = freshToken(); const refreshToken = freshToken();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_LIFETIME_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_LIFETIME_MS);
  await getPrismaClient().mobileSession.create({ data: {
    userId: identity.userId, issuer: identity.issuer, subject: identity.subject,
    accessHash: hash(accessToken), refreshHash: hash(refreshToken), accessExpiresAt, refreshExpiresAt,
  } });
  return { accessToken, refreshToken, accessExpiresAt: accessExpiresAt.toISOString(), refreshExpiresAt: refreshExpiresAt.toISOString() };
}

export async function mobileSessionCustomer(authorization: string | null): Promise<string | undefined> {
  const token = bearer(authorization); if (!token || !TOKEN_PATTERN.test(token)) return;
  const db = getPrismaClient();
  const session = await db.mobileSession.findUnique({ where: { accessHash: hash(token) }, select: { userId: true, issuer: true, subject: true, accessExpiresAt: true, revokedAt: true } });
  if (!session || session.revokedAt || session.accessExpiresAt <= new Date()) return;
  const identity = await db.externalIdentity.findUnique({ where: { issuer_subject: { issuer: session.issuer, subject: session.subject } }, select: { userId: true } });
  return identity?.userId === session.userId ? session.userId : undefined;
}

export async function rotateMobileSession(refreshToken: string): Promise<Awaited<ReturnType<typeof createMobileSession>> | undefined> {
  if (!TOKEN_PATTERN.test(refreshToken)) return;
  const db = getPrismaClient(); const oldHash = hash(refreshToken); const now = new Date();
  const session = await db.mobileSession.findUnique({ where: { refreshHash: oldHash }, select: { id: true, userId: true, issuer: true, subject: true, refreshExpiresAt: true, revokedAt: true } });
  if (!session || session.revokedAt || session.refreshExpiresAt <= now) return;
  const identity = await db.externalIdentity.findUnique({ where: { issuer_subject: { issuer: session.issuer, subject: session.subject } }, select: { userId: true } });
  if (identity?.userId !== session.userId) return;
  const accessToken = freshToken(); const nextRefreshToken = freshToken();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_LIFETIME_MS);
  const refreshExpiresAt = session.refreshExpiresAt;
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
  if (!TOKEN_PATTERN.test(accessToken)) return;
  await getPrismaClient().mobileSession.updateMany({ where: { accessHash: hash(accessToken), revokedAt: null }, data: { revokedAt: new Date() } });
}
