import type { IntentDraftV1 } from "@parlance/contracts";

export interface InterpretUserRequestInput {
  text: string;
  userId: string;
}

/** Input supplied to a provider adapter; it contains no provider-specific types. */
export interface IntentModelInput {
  text: string;
  systemPrompt: string;
  promptVersion: string;
}

export interface IntentModelClient {
  generateIntent(input: IntentModelInput): Promise<unknown>;
}

export interface IntentInterpreter {
  interpretUserRequest(input: InterpretUserRequestInput): Promise<IntentDraftV1>;
}

export type IntentValidationIssue = {
  path: readonly (string | number)[];
  code: string;
  message: string;
  keys?: readonly string[];
};
