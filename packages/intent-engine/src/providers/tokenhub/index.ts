import { ModelBackedIntentInterpreter } from "../../interpreter/interpreter.js";
import { TokenHubIntentModelClient } from "./client.js";
import { loadTokenHubConfig } from "./config.js";

/** Creates a fresh configured client; no client or environment is read at module import time. */
export function createTokenHubIntentInterpreter(options: TokenHubIntentInterpreterOptions = {}): ModelBackedIntentInterpreter {
  return new ModelBackedIntentInterpreter(new TokenHubIntentModelClient(loadTokenHubConfig(options.environment)));
}

export interface TokenHubIntentInterpreterOptions {
  environment?: NodeJS.ProcessEnv;
}

export { projectTokenHubTransportCandidate, TokenHubIntentModelClient, TokenHubProviderError } from "./client.js";
export { loadTokenHubConfig, TokenHubConfigurationError } from "./config.js";
export type { TokenHubConfig, TokenHubThinkingMode } from "./config.js";
