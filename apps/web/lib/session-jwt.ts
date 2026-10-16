import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export function sessionJwtKey() {
  const secret = process.env.PARLANCE_AUTH_JWT_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("AUTH_NOT_CONFIGURED");
  const other = [process.env.PARLANCE_INTERNAL_API_TOKEN, process.env.PARLANCE_BANK_API_TOKEN, process.env.PARLANCE_OPS_API_TOKEN];
  if (other.includes(secret)) throw new Error("AUTH_SECRET_MUST_BE_SEPARATE");
  return new TextEncoder().encode(secret);
}
export function passwordAuthReady() { try { sessionJwtKey(); return true; } catch { return false; } }
const issuer = () => process.env.PARLANCE_AUTH_JWT_ISSUER?.trim() || "parlance";
const audience = "parlance-customer";
export async function signSessionJwt(userId: string, expiresAt: Date) {
  return new SignJWT({ purpose: "customer-access" }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId).setIssuer(issuer()).setAudience(audience).setJti(randomUUID()).setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000)).sign(sessionJwtKey());
}
export async function verifySessionJwt(token: string): Promise<string | undefined> {
  try {
    const { payload } = await jwtVerify(token, sessionJwtKey(), { algorithms: ["HS256"], issuer: issuer(), audience, requiredClaims: ["sub", "exp", "iat", "jti"] });
    return payload.purpose === "customer-access" && typeof payload.sub === "string" ? payload.sub : undefined;
  } catch { return; }
}
