const DEFAULT_TOKENHUB_BASE_URL = "https://tokenhub-intl.tencentcloudmaas.com/v1";
const DEFAULT_TOKENHUB_MODEL = "hy3";

export interface TokenHubConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class TokenHubConfigurationError extends Error {
  readonly name = "TokenHubConfigurationError";
}

/** Loads TokenHub settings once, keeping environment access out of the provider client. */
export function loadTokenHubConfig(environment: NodeJS.ProcessEnv = process.env): TokenHubConfig {
  const apiKey = environment.TOKENHUB_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new TokenHubConfigurationError("TOKENHUB_API_KEY is required to use TokenHub.");
  }
  return {
    apiKey,
    baseUrl: environment.TOKENHUB_BASE_URL || DEFAULT_TOKENHUB_BASE_URL,
    model: environment.TOKENHUB_MODEL || DEFAULT_TOKENHUB_MODEL,
  };
}
