const DEFAULT_TOKENHUB_BASE_URL = "https://tokenhub-intl.tencentcloudmaas.com/v1";
const DEFAULT_TOKENHUB_MODEL = "hy3";

export type TokenHubThinkingMode = "disabled" | "enabled";

export interface TokenHubConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking?: TokenHubThinkingMode;
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
  const thinking = environment.TOKENHUB_THINKING;
  if (thinking !== undefined && thinking !== "disabled" && thinking !== "enabled") {
    throw new TokenHubConfigurationError('TOKENHUB_THINKING must be either "disabled" or "enabled" when set.');
  }
  return {
    apiKey,
    baseUrl: environment.TOKENHUB_BASE_URL || DEFAULT_TOKENHUB_BASE_URL,
    model: environment.TOKENHUB_MODEL || DEFAULT_TOKENHUB_MODEL,
    ...(thinking === undefined ? {} : { thinking }),
  };
}
