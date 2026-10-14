import type { DiscoveryDocument } from "expo-auth-session";

type PublicConnection = { apiBaseUrl: string; oidcIssuer: string; oidcClientId: string; oidcAudience: string };

function httpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url : undefined;
  } catch { return; }
}

export function connectionConfigured(value: PublicConnection): boolean {
  const api = httpsUrl(value.apiBaseUrl);
  const issuer = httpsUrl(value.oidcIssuer);
  return !!api && api.pathname === "/" && !!issuer && !!value.oidcClientId.trim() && !!value.oidcAudience.trim();
}

export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`;
}

export function trustedDiscovery(issuer: string, metadata: unknown): DiscoveryDocument | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
  const value = metadata as Record<string, unknown>;
  if (value.issuer !== issuer || typeof value.authorization_endpoint !== "string" || typeof value.token_endpoint !== "string" || typeof value.jwks_uri !== "string") return;
  if (!httpsUrl(value.authorization_endpoint) || !httpsUrl(value.token_endpoint) || !httpsUrl(value.jwks_uri)) return;
  if (value.code_challenge_methods_supported !== undefined && (!Array.isArray(value.code_challenge_methods_supported) || !value.code_challenge_methods_supported.includes("S256"))) return;
  return { authorizationEndpoint: value.authorization_endpoint, tokenEndpoint: value.token_endpoint };
}
