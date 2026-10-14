import { expect, it } from "vitest";
import { connectionConfigured, discoveryUrl, trustedDiscovery } from "./connection";

const publicValues = { apiBaseUrl: "https://bank.example", oidcIssuer: "https://identity.example/", oidcClientId: "native-client", oidcAudience: "https://bank.example/mobile-api" };
const discovery = { issuer: publicValues.oidcIssuer, authorization_endpoint: "https://identity.example/authorize", token_endpoint: "https://identity.example/oauth/token", jwks_uri: "https://identity.example/.well-known/jwks.json", code_challenge_methods_supported: ["S256"] };

it("keeps the connection gate closed for missing, insecure or malformed public values", () => {
  expect(connectionConfigured(publicValues)).toBe(true);
  for (const changed of [
    { oidcAudience: "" }, { oidcClientId: "" }, { oidcIssuer: "http://identity.example" },
    { apiBaseUrl: "https://bank.example/api/mobile" }, { apiBaseUrl: "https://user:pass@bank.example" },
    { apiBaseUrl: "https://bank.example?target=evil" },
  ]) expect(connectionConfigured({ ...publicValues, ...changed })).toBe(false);
});

it("accepts only matching OIDC issuer metadata with HTTPS endpoints and PKCE S256", () => {
  expect(discoveryUrl(publicValues.oidcIssuer)).toBe("https://identity.example/.well-known/openid-configuration");
  expect(trustedDiscovery(publicValues.oidcIssuer, discovery)).toEqual({ authorizationEndpoint: discovery.authorization_endpoint, tokenEndpoint: discovery.token_endpoint });
  for (const changed of [
    { issuer: "https://other.example/" }, { token_endpoint: "http://identity.example/oauth/token" },
    { jwks_uri: "http://identity.example/keys" }, { code_challenge_methods_supported: ["plain"] },
  ]) expect(trustedDiscovery(publicValues.oidcIssuer, { ...discovery, ...changed })).toBeUndefined();
});
