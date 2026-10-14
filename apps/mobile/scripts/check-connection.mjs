// Read-only deployment preflight. It sends no customer token and makes no banking write.
const api = process.env.PARLANCE_MOBILE_PUBLIC_API_URL;
const issuer = process.env.PARLANCE_MOBILE_PUBLIC_OIDC_ISSUER;
const clientId = process.env.PARLANCE_MOBILE_PUBLIC_OIDC_CLIENT_ID;
const audience = process.env.PARLANCE_MOBILE_PUBLIC_OIDC_AUDIENCE;

function secureUrl(value, originOnly = false) {
  if (!value) throw new Error("Missing a required public mobile setting");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || originOnly && parsed.pathname !== "/") {
    throw new Error(`Invalid HTTPS ${originOnly ? "API origin" : "issuer URL"}`);
  }
  return parsed;
}

async function get(url) {
  const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10000) });
  if (response.status >= 300 && response.status < 400) throw new Error(`Unexpected redirect at ${url}`);
  return response;
}

try {
  const apiOrigin = secureUrl(api, true).origin;
  secureUrl(issuer);
  if (!clientId?.trim() || !audience?.trim()) throw new Error("Missing public native client ID or API audience");

  const metadataUrl = `${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`;
  const metadataResponse = await get(metadataUrl);
  if (!metadataResponse.ok) throw new Error(`OIDC discovery returned HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  if (metadata.issuer !== issuer) throw new Error("OIDC issuer does not match discovery metadata exactly");
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) secureUrl(metadata[key]);
  if (metadata.code_challenge_methods_supported !== undefined && (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256"))) throw new Error("Provider does not advertise PKCE S256");
  const jwks = await get(metadata.jwks_uri);
  if (!jwks.ok || !Array.isArray((await jwks.json()).keys)) throw new Error("OIDC JWKS is unavailable");

  const mobile = await get(`${apiOrigin}/api/mobile/customer/state`);
  if (mobile.status !== 401) throw new Error(`Unauthenticated mobile state returned HTTP ${mobile.status}; expected 401`);
  const fixedWeb = await get(`${apiOrigin}/api/parlance/customer/state`);
  if (fixedWeb.status === 200) throw new Error("Public fixed-customer web proxy exposes customer state");

  console.log("PASS: HTTPS OIDC discovery and JWKS, mobile authorization boundary, and fixed-customer proxy check");
  console.log("Still required: authenticated customer sign-in, mapped identity, and shared-state verification on an approved test deployment.");
} catch (error) {
  console.error(`Connection preflight failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
