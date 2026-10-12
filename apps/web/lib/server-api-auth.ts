import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const INTERNAL_TOKEN_HEADER = "x-parlance-internal-token";
export const CUSTOMER_PRINCIPAL_HEADER = "x-parlance-customer-id";
export const OPS_TOKEN_HEADER = "x-parlance-ops-token";
export const BANK_TOKEN_HEADER = "x-parlance-bank-token";
export const OPERATOR_SESSION_COOKIE = "parlance_operator_session";
export const OPERATOR_SESSION_MAX_AGE_SECONDS = 15 * 60;
const OPERATOR_SESSION_CLOCK_SKEW_SECONDS = 30;

export function apiBaseUrl(): string {
  return (process.env.API_URL?.trim() || "http://127.0.0.1:4001").replace(/\/$/u, "");
}

export function customerApiHeaders(): Record<string, string> | undefined {
  const token = configured(process.env.PARLANCE_INTERNAL_API_TOKEN);
  const userId = configuredCustomerUserId();
  if (!token || !userId || !webSecurityConfigurationValid()) return undefined;
  return { [INTERNAL_TOKEN_HEADER]: token, [CUSTOMER_PRINCIPAL_HEADER]: userId };
}

export function opsApiHeaders(): Record<string, string> | undefined {
  const token = configured(process.env.PARLANCE_OPS_API_TOKEN);
  return token && webSecurityConfigurationValid() ? { [OPS_TOKEN_HEADER]: token } : undefined;
}

export function bankApiHeaders(): Record<string, string> | undefined {
  const token = configured(process.env.PARLANCE_BANK_API_TOKEN);
  return token && webSecurityConfigurationValid() ? { [BANK_TOKEN_HEADER]: token } : undefined;
}

export function createOperatorSession(accessToken: string, now = Date.now()): string | undefined {
  const accessSecret = configured(process.env.PARLANCE_OPERATOR_ACCESS_TOKEN);
  const sessionSecret = configured(process.env.PARLANCE_OPERATOR_SESSION_SECRET);
  if (!accessSecret || !sessionSecret || !webSecurityConfigurationValid() || !safeEqual(accessToken, accessSecret)) return undefined;
  const issuedAt = Math.floor(now / 1000);
  const payload = `v1.${issuedAt}.${issuedAt + OPERATOR_SESSION_MAX_AGE_SECONDS}`;
  return `${payload}.${sign(payload, sessionSecret)}`;
}

export function operatorSessionValid(cookie: string | undefined, now = Date.now()): boolean {
  const accessSecret = configured(process.env.PARLANCE_OPERATOR_ACCESS_TOKEN);
  const sessionSecret = configured(process.env.PARLANCE_OPERATOR_SESSION_SECRET);
  if (!accessSecret || !sessionSecret || !cookie || !webSecurityConfigurationValid()) return false;
  const match = /^(v1)\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/u.exec(cookie);
  if (!match) return false;
  const nowSeconds = Math.floor(now / 1000); const issuedAt = Number(match[2]); const expiresAt = Number(match[3]);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds || expiresAt <= issuedAt) return false;
  if (expiresAt - issuedAt > OPERATOR_SESSION_MAX_AGE_SECONDS || issuedAt > nowSeconds + OPERATOR_SESSION_CLOCK_SKEW_SECONDS) return false;
  const payload = `${match[1]}.${match[2]}.${match[3]}`;
  return safeEqual(match[4]!, sign(payload, sessionSecret));
}

export function webSecurityConfigurationValid(): boolean {
  const secrets = [
    process.env.PARLANCE_INTERNAL_API_TOKEN, process.env.PARLANCE_OPS_API_TOKEN,
    process.env.PARLANCE_OPERATOR_ACCESS_TOKEN, process.env.PARLANCE_OPERATOR_SESSION_SECRET,
    process.env.PARLANCE_BANK_API_TOKEN,
  ].map(configured).filter((value): value is string => value !== undefined);
  return secrets.every((value, index) => secrets.slice(index + 1).every((other) => !safeEqual(value, other)));
}

export function configuredCustomerUserId(): string | undefined {
  const customer = configured(process.env.PARLANCE_CUSTOMER_USER_ID);
  if (!customer) return undefined;
  const demo = configured(process.env.PARLANCE_DEMO_USER_ID);
  const fixedDemoEnabled = demoModeEnabled() || process.env.PARLANCE_DEMO_WEBAUTHN_ENROLLMENT === "true";
  return fixedDemoEnabled && (!demo || demo !== customer) ? undefined : customer;
}

export function configuredDemoUserId(): string | undefined {
  const customer = configured(process.env.PARLANCE_CUSTOMER_USER_ID);
  const demo = configured(process.env.PARLANCE_DEMO_USER_ID);
  return customer && demo && customer === demo ? demo : undefined;
}

export function demoModeEnabled(): boolean {
  return process.env.PARLANCE_DEMO_MODE === "true";
}

export function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

function configured(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
