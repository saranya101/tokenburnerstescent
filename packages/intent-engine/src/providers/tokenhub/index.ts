import { ModelBackedIntentInterpreter } from "../../interpreter/interpreter.js";
import { TokenHubIntentModelClient, type TokenHubDevelopmentDiagnostics } from "./client.js";
import { loadTokenHubConfig } from "./config.js";

/** Creates a fresh configured client; no client or environment is read at module import time. */
export function createTokenHubIntentInterpreter(options: TokenHubIntentInterpreterOptions = {}): ModelBackedIntentInterpreter {
  return new ModelBackedIntentInterpreter(new TokenHubIntentModelClient(
    loadTokenHubConfig(options.environment),
    undefined,
    options.developmentDiagnostics,
  ));
}

export interface TokenHubIntentInterpreterOptions {
  environment?: NodeJS.ProcessEnv;
  developmentDiagnostics?: TokenHubDevelopmentDiagnostics;
}

export { projectTokenHubTransportCandidate, TokenHubIntentModelClient, TokenHubProviderError } from "./client.js";
export type { TokenHubConstraintProjectionDiagnostic, TokenHubDevelopmentDiagnostics } from "./client.js";
export { loadTokenHubConfig, TokenHubConfigurationError } from "./config.js";
export type { TokenHubConfig, TokenHubThinkingMode } from "./config.js";
